"""Canonical Gradient q4 checkpoint: identity, layout and dequantization.

The checkpoint is the MLX affine q4/group64 file that every Deckard backend has
used since v0.5.0. It cannot be regenerated bit-for-bit on Linux (MLX CPU and
Metal round a small fraction of groups differently), so it is fetched verbatim
by scripts/fetch-canonical-model.sh and verified here.
"""

import hashlib
from pathlib import Path

import numpy as np

MODEL = "ShantanuT01/gradient-ai-text-detector"
REVISION = "c2e8b6df87f8a211cbffb713fa9873a0c3a9713f"
PACKED_SHA256 = "85a9e02ebdcbbe1dd84cdbf893b708e44ee4691cadc7e1a4780039e22097ac98"
TOKENIZER_SHA256 = "4b4f60231058db4b5794e7b124bb7945bc8ade6719282de4d2e0372ee527b929"
HIDDEN, INTERMEDIATE, HEADS, HEAD_DIM, LAYERS, VOCAB = 1024, 4096, 16, 64, 24, 128100
MAX_LENGTH, POSITION_SPAN, GROUP = 512, 256, 64
EPSILON = 1e-7

# Pinned upstream config.json at REVISION (embedded so export needs no network).
CONFIG = {
    "architectures": ["DebertaV2ForSequenceClassification"], "attention_probs_dropout_prob": 0.1,
    "hidden_act": "gelu", "hidden_dropout_prob": 0.1, "hidden_size": HIDDEN,
    "id2label": {"0": "LABEL_0"}, "label2id": {"LABEL_0": 0}, "initializer_range": 0.02,
    "intermediate_size": INTERMEDIATE, "layer_norm_eps": EPSILON, "max_position_embeddings": MAX_LENGTH,
    "max_relative_positions": -1, "model_type": "deberta-v2", "norm_rel_ebd": "layer_norm",
    "num_attention_heads": HEADS, "num_hidden_layers": LAYERS, "pad_token_id": 0, "pooler_dropout": 0,
    "pooler_hidden_act": "gelu", "pooler_hidden_size": HIDDEN, "pos_att_type": ["p2c", "c2p"],
    "position_biased_input": False, "position_buckets": POSITION_SPAN, "relative_attention": True,
    "share_att_key": True, "type_vocab_size": 0, "vocab_size": VOCAB,
}


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def verify(directory):
    directory = Path(directory)
    if sha256(directory / "packed.safetensors") != PACKED_SHA256:
        raise ValueError("Expected Deckard's canonical Gradient q4 checkpoint.")
    if sha256(directory / "tokenizer.json") != TOKENIZER_SHA256:
        raise ValueError("Expected Deckard's canonical Gradient tokenizer.")


def load(directory):
    from safetensors.numpy import load_file

    verify(directory)
    weights = load_file(str(Path(directory) / "packed.safetensors"))
    if len(weights) != 690:
        raise ValueError("The canonical checkpoint must contain 690 packed tensors.")
    return weights


def nibbles(weight):
    """uint32 words -> uint8 values in 0..15, eight per word, low nibble first."""
    if weight.dtype != np.uint32:
        raise ValueError("Packed q4 weights must be uint32.")
    values = (weight[..., None] >> (np.arange(8, dtype=np.uint32) * 4)) & 15
    return values.reshape(*weight.shape[:-1], weight.shape[-1] * 8).astype(np.uint8)


def unpack(weight, scales, biases):
    """MLX affine q4/group64 dequantization, with the reference FP16 rounding point."""
    if scales.dtype != np.float16 or biases.dtype != np.float16:
        raise ValueError("Invalid packed tensor dtypes.")
    values = nibbles(weight)
    rows, columns = values.shape
    if columns % GROUP or scales.shape != (rows, columns // GROUP) or biases.shape != scales.shape:
        raise ValueError("Invalid packed tensor shapes.")
    values = values.reshape(rows, columns // GROUP, GROUP).astype(np.float32)
    values = values * scales.astype(np.float32)[..., None] + biases.astype(np.float32)[..., None]
    return values.reshape(rows, columns).astype(np.float16).astype(np.float32)


def modules():
    """Canonical module name -> Hugging Face parameter prefix."""
    names = {
        "embeddings.word": "deberta.embeddings.word_embeddings",
        "embeddings.norm": "deberta.embeddings.LayerNorm",
        "relative_embeddings": "deberta.encoder.rel_embeddings",
        "relative_norm": "deberta.encoder.LayerNorm",
        "pooler": "pooler.dense", "classifier": "classifier",
    }
    for index in range(LAYERS):
        source, target = f"deberta.encoder.layer.{index}", f"layers.{index}"
        for projection in ("query", "key", "value"):
            names[f"{target}.attention.{projection}"] = f"{source}.attention.self.{projection}_proj"
        names.update({
            f"{target}.attention_output": f"{source}.attention.output.dense",
            f"{target}.attention_norm": f"{source}.attention.output.LayerNorm",
            f"{target}.intermediate": f"{source}.intermediate.dense",
            f"{target}.output": f"{source}.output.dense",
            f"{target}.output_norm": f"{source}.output.LayerNorm",
        })
    return names


def reference_model(weights):
    """Upstream DebertaV2ForSequenceClassification carrying the dequantized q4 weights."""
    import torch
    from transformers import DebertaV2Config, DebertaV2ForSequenceClassification

    model = DebertaV2ForSequenceClassification(DebertaV2Config(**CONFIG)).eval()
    state = model.state_dict()
    loaded = {}
    for canonical, upstream in modules().items():
        if canonical + ".scales" in weights:
            value = unpack(weights[canonical + ".weight"], weights[canonical + ".scales"],
                           weights[canonical + ".biases"])
        else:
            value = weights[canonical + ".weight"].astype(np.float32)
        loaded[upstream + ".weight"] = torch.from_numpy(value)
        if upstream + ".bias" in state:
            loaded[upstream + ".bias"] = torch.from_numpy(weights[canonical + ".bias"].astype(np.float32))
    missing = set(state) - set(loaded)
    if missing:
        raise ValueError(f"Unmapped reference parameters: {sorted(missing)[:3]}")
    model.load_state_dict(loaded)
    return model
