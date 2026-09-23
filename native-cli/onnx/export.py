"""Export Deckard's canonical Gradient q4 checkpoint to an exact ONNX Runtime model.

The graph mirrors native-cli's historical MLX forward pass (DeBERTa-v3 with
disentangled c2p/p2c attention). Every q4 projection becomes a com.microsoft
MatMulNBits node whose 4-bit codes and FP16 scales are copied verbatim; MLX's
affine bias b is expressed as a float zero point -b/s, so s*(q - zp) equals the
canonical s*q + b. Word embeddings stay packed 4-bit and are dequantized per
gathered token. The input-independent relative-position projections are
precomputed in FP32. Activations are FP32 throughout.

Outputs (in --output, which must not exist):
  model.onnx, model.onnx.data, tokenizer.json, fixtures.json, export.json
"""

import argparse
import json
import math
import os
import shutil
import sys
from pathlib import Path

import numpy as np

import gradient_q4 as q4

OPSET = 18


def bucket(relative):
    distance, middle = abs(relative), q4.POSITION_SPAN // 2
    if distance <= middle:
        return relative
    value = int(math.ceil(math.log(distance / middle) / math.log((q4.MAX_LENGTH - 1) / middle)
                          * (middle - 1))) + middle
    return value if relative > 0 else -value


def position_indices():
    lookup = np.array([bucket(value) for value in range(1 - q4.MAX_LENGTH, q4.MAX_LENGTH)], np.int64)
    sequence = np.arange(q4.MAX_LENGTH)
    relative = lookup[sequence[:, None] - sequence[None, :] + q4.MAX_LENGTH - 1]
    high = 2 * q4.POSITION_SPAN - 1
    return (np.clip(relative + q4.POSITION_SPAN, 0, high), np.clip(q4.POSITION_SPAN - relative, 0, high))


class Graph:
    def __init__(self):
        self.nodes, self.initializers, self.names, self.count = [], [], set(), 0

    def constant(self, name, value):
        from onnx import numpy_helper
        if name in self.names:
            return name
        self.names.add(name)
        # np.ascontiguousarray would promote scalars to shape [1].
        self.initializers.append(numpy_helper.from_array(np.array(value, order="C"), name))
        return name

    def op(self, op_type, inputs, domain=None, outputs=1, **attributes):
        from onnx import helper
        self.count += 1
        names = [f"{op_type.lower()}_{self.count}" + (f"_{i}" if outputs > 1 else "") for i in range(outputs)]
        self.nodes.append(helper.make_node(op_type, list(inputs), names, name=f"n{self.count}",
                                           domain=domain, **attributes))
        return names[0] if outputs == 1 else names


def build(weights, reference):
    import torch
    from onnx import TensorProto, helper

    g = Graph()
    f32 = lambda name, value: g.constant(name, np.asarray(value, np.float32))
    i64 = lambda name, value: g.constant(name, np.asarray(value, np.int64))

    def linear(name, x):
        packed = q4.nibbles(weights[name + ".weight"])
        rows, columns = packed.shape
        blocks = (packed[:, 0::2] | (packed[:, 1::2] << 4)).reshape(rows, columns // q4.GROUP, q4.GROUP // 2)
        scales = weights[name + ".scales"].astype(np.float32)
        points = -weights[name + ".biases"].astype(np.float32) / scales
        if not np.all(np.isfinite(points)):
            raise ValueError(f"Non-finite zero point in {name}.")
        product = g.op("MatMulNBits", [x, g.constant(name + ".q4", blocks), f32(name + ".scales", scales.reshape(-1)),
                                       f32(name + ".zero_points", points.reshape(-1))],
                       domain="com.microsoft", K=columns, N=rows, bits=4, block_size=q4.GROUP, accuracy_level=0)
        return g.op("Add", [product, f32(name + ".bias", weights[name + ".bias"])])

    def norm(name, x):
        return g.op("LayerNormalization", [x, f32(name + ".weight", weights[name + ".weight"]),
                                           f32(name + ".bias", weights[name + ".bias"])],
                    axis=-1, epsilon=q4.EPSILON)

    def gelu(x):
        inner = g.op("Erf", [g.op("Div", [x, f32("sqrt2", math.sqrt(2.0))])])
        return g.op("Mul", [g.op("Mul", [x, g.op("Add", [inner, f32("one", 1.0)])]), f32("half", 0.5)])

    # Word embeddings: packed nibble pairs, per-group FP16 scale/bias, reference FP16 rounding.
    codes = q4.nibbles(weights["embeddings.word.weight"])
    word = g.constant("embeddings.word.q4", codes[:, 0::2] | (codes[:, 1::2] << 4))
    gathered = g.op("Gather", [word, "input_ids"], axis=0)
    low = g.op("BitwiseAnd", [gathered, g.constant("nibble_mask", np.array(15, np.uint8))])
    high = g.op("BitShift", [gathered, g.constant("nibble_shift", np.array(4, np.uint8))], direction="RIGHT")
    pairs = g.op("Concat", [g.op("Unsqueeze", [low, i64("axis_last", [-1])]),
                            g.op("Unsqueeze", [high, "axis_last"])], axis=-1)
    grouped = g.op("Cast", [g.op("Reshape", [pairs, i64("group_shape", [1, -1, 16, q4.GROUP])])],
                   to=TensorProto.FLOAT)
    group_scale = g.op("Unsqueeze", [g.op("Cast", [g.op("Gather", [
        g.constant("embeddings.word.scales", weights["embeddings.word.scales"]), "input_ids"], axis=0)],
        to=TensorProto.FLOAT), "axis_last"])
    group_bias = g.op("Unsqueeze", [g.op("Cast", [g.op("Gather", [
        g.constant("embeddings.word.biases", weights["embeddings.word.biases"]), "input_ids"], axis=0)],
        to=TensorProto.FLOAT), "axis_last"])
    dequantized = g.op("Add", [g.op("Mul", [grouped, group_scale]), group_bias])
    rounded = g.op("Cast", [g.op("Cast", [dequantized], to=TensorProto.FLOAT16)], to=TensorProto.FLOAT)
    embedded = g.op("Reshape", [rounded, i64("hidden_shape", [1, -1, q4.HIDDEN])])
    mask = g.op("Cast", ["attention_mask"], to=TensorProto.FLOAT)
    x = g.op("Mul", [norm("embeddings.norm", embedded), g.op("Unsqueeze", [mask, "axis_last"])])

    # Relative-position gather indices for the current length, and a key mask.
    length = g.op("Gather", [g.op("Shape", ["input_ids"]), i64("one_index", [1])], axis=0)
    c2p_index, p2c_index = position_indices()
    zero = i64("zero_index", [0])
    window = lambda name, table: g.op("Expand", [
        g.op("Slice", [g.op("Slice", [g.constant(name, table), zero, length, zero]), zero, length, i64("axis_one", [1])]),
        g.op("Concat", [i64("heads_prefix", [1, q4.HEADS]), length, length], axis=0)])
    c2p_positions, p2c_positions = window("c2p_index", c2p_index), window("p2c_index", p2c_index)
    key_mask = g.op("Cast", [g.op("Unsqueeze", ["attention_mask", i64("mask_axes", [1, 2])])], to=TensorProto.BOOL)
    lowest = f32("lowest", np.finfo(np.float32).min)
    scale = f32("attention_scale", math.sqrt(q4.HEAD_DIM * 3.0))
    heads = i64("heads_shape", [1, -1, q4.HEADS, q4.HEAD_DIM])

    with torch.inference_mode():
        relative = reference.deberta.encoder.get_rel_embedding()
        for index in range(q4.LAYERS):
            prefix = f"layers.{index}"
            attention = reference.deberta.encoder.layer[index].attention.self
            tables = {}
            for projection, module in (("query", attention.query_proj), ("key", attention.key_proj)):
                value = module(relative).reshape(2 * q4.POSITION_SPAN, q4.HEADS, q4.HEAD_DIM)
                tables[projection] = f32(f"{prefix}.position_{projection}",
                                         value.permute(1, 2, 0).unsqueeze(0).numpy())
            split = lambda value: g.op("Reshape", [value, heads])
            query = g.op("Transpose", [split(linear(prefix + ".attention.query", x))], perm=[0, 2, 1, 3])
            key_rows = split(linear(prefix + ".attention.key", x))
            key = g.op("Transpose", [key_rows], perm=[0, 2, 1, 3])
            key_t = g.op("Transpose", [key_rows], perm=[0, 2, 3, 1])
            value = g.op("Transpose", [split(linear(prefix + ".attention.value", x))], perm=[0, 2, 1, 3])
            content = g.op("MatMul", [query, key_t])
            c2p = g.op("GatherElements", [g.op("MatMul", [query, tables["key"]]), c2p_positions], axis=3)
            p2c = g.op("Transpose", [g.op("GatherElements", [g.op("MatMul", [key, tables["query"]]), p2c_positions],
                                          axis=3)], perm=[0, 1, 3, 2])
            scores = g.op("Div", [g.op("Add", [g.op("Add", [content, c2p]), p2c]), scale])
            probabilities = g.op("Softmax", [g.op("Where", [key_mask, scores, lowest])], axis=-1)
            attended = g.op("Reshape", [g.op("Transpose", [g.op("MatMul", [probabilities, value])], perm=[0, 2, 1, 3]),
                                        "hidden_shape"])
            x = norm(prefix + ".attention_norm", g.op("Add", [linear(prefix + ".attention_output", attended), x]))
            x = norm(prefix + ".output_norm", g.op("Add", [
                linear(prefix + ".output", gelu(linear(prefix + ".intermediate", x))), x]))

    pooled = gelu(linear("pooler", g.op("Gather", [x, i64("cls_index", 0)], axis=1)))
    logits = linear("classifier", pooled)
    g.nodes.append(helper.make_node("Identity", [logits], ["logits"], name="output"))
    graph = helper.make_graph(
        g.nodes, "gradient_q4",
        [helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "sequence"]),
         helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "sequence"])],
        [helper.make_tensor_value_info("logits", TensorProto.FLOAT, [1, 1])], g.initializers)
    model = helper.make_model(graph, producer_name="deckard-onnx-export", producer_version="1",
                              opset_imports=[helper.make_opsetid("", OPSET), helper.make_opsetid("com.microsoft", 1)])
    model.ir_version = 9
    model.doc_string = json.dumps({"model": q4.MODEL, "revision": q4.REVISION, "source_sha256": q4.PACKED_SHA256,
                                   "format": "deckard-gradient-q4-onnx-v1"}, sort_keys=True)
    return model


def cases():
    """Synthetic canonical fixtures (lengths 32/128/512, padded and unpadded) plus mixed lengths."""
    rows = []
    for length in (32, 128, 512):
        for step in (11, 97):
            for padded in (False, True):
                used = length // 2 + 1 if padded else length
                ids = [3 + index * step for index in range(used)]
                ids[0], ids[-1] = 1, 2
                ids += [0] * (length - used)
                rows.append((f"length{length}-values{step}" + ("-padded" if padded else ""),
                             ids, [1] * used + [0] * (length - used)))
    generator = np.random.default_rng(20260923)
    for length in (3, 57, 300, 511):
        ids = [1] + generator.integers(5, q4.VOCAB, length - 2).tolist() + [2]
        rows.append((f"random-length{length}", ids, [1] * length))
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--canonical", type=Path, required=True,
                        help="Directory with canonical packed.safetensors and tokenizer.json.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    import onnx
    import onnxruntime as ort
    import torch

    torch.set_num_threads(args.threads)
    weights = q4.load(args.canonical)
    reference = q4.reference_model(weights)
    model = build(weights, reference)
    staging = args.output.with_name(args.output.name + ".partial")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    onnx.save_model(model, str(staging / "model.onnx"), save_as_external_data=True, all_tensors_to_one_file=True,
                    location="model.onnx.data", size_threshold=1024, convert_attribute=False)
    onnx.checker.check_model(str(staging / "model.onnx"))
    shutil.copyfile(args.canonical / "tokenizer.json", staging / "tokenizer.json")

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(staging / "model.onnx"), options, providers=["CPUExecutionProvider"])
    sigmoid = lambda value: 1 / (1 + math.exp(-value))
    fixtures, worst, same = [], 0.0, True
    for name, ids, mask in cases():
        with torch.inference_mode():
            expected = reference(input_ids=torch.tensor([ids]), attention_mask=torch.tensor([mask])).logits.item()
        actual = session.run(None, {"input_ids": np.array([ids], np.int64),
                                    "attention_mask": np.array([mask], np.int64)})[0].item()
        worst = max(worst, abs(sigmoid(actual) - sigmoid(expected)))
        same &= (sigmoid(actual) >= 0.97) == (sigmoid(expected) >= 0.97)
        print(f"{name:28} reference {expected:9.5f} onnx {actual:9.5f}", flush=True)
        fixtures.append({"name": name, "logit": expected, "score": sigmoid(expected),
                         "feed": {"input_ids": [ids], "attention_mask": [mask]}})
    if worst > 1e-3 or not same:
        raise SystemExit(f"ONNX export failed parity: max score error {worst:.2e}, same decisions {same}.")
    (staging / "fixtures.json").write_text(json.dumps({"reference": "pytorch-fp32-dequantized-canonical-q4",
                                                        "cases": fixtures}) + "\n")
    files = {name: q4.sha256(staging / name) for name in ("model.onnx", "model.onnx.data", "tokenizer.json")}
    (staging / "export.json").write_text(json.dumps({
        "source_weights_sha256": q4.PACKED_SHA256, "files": files, "max_score_error": worst,
        "versions": {"onnx": onnx.__version__, "onnxruntime": ort.__version__, "torch": torch.__version__,
                     "numpy": np.__version__, "python": sys.version.split()[0]},
    }, indent=2) + "\n")
    os.replace(staging, args.output)
    print(json.dumps({"max_score_error": worst, "files": files}, indent=2))


if __name__ == "__main__":
    main()
