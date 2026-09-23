"""Unit tests for export helpers that need neither the checkpoint nor torch.

Run from native-cli/onnx: python -m unittest test_export
"""

import unittest

import numpy as np

import gradient_q4 as q4
from export import bucket, position_indices


class Helpers(unittest.TestCase):
    def test_nibbles_are_low_first(self):
        word = np.array([[0x76543210, 0xFEDCBA98]], np.uint32)
        self.assertEqual(q4.nibbles(word).tolist(), [list(range(16))])

    def test_unpack_applies_affine_groups_with_fp16_rounding(self):
        codes = np.arange(64, dtype=np.uint32) % 16
        words = (codes.reshape(8, 8) << (np.arange(8, dtype=np.uint32) * 4)).sum(axis=1, dtype=np.uint32)
        scales = np.array([[0.1]], np.float16)
        biases = np.array([[-0.5]], np.float16)
        values = q4.unpack(words.reshape(1, 8), scales, biases)
        expected = (codes * np.float32(scales[0, 0]) + np.float32(biases[0, 0])).astype(np.float16)
        np.testing.assert_array_equal(values[0], expected.astype(np.float32))

    def test_log_buckets_match_deberta(self):
        self.assertEqual([bucket(value) for value in (0, 1, -128, 128)], [0, 1, -128, 128])
        self.assertEqual(bucket(511), 255)
        self.assertEqual(bucket(-511), -255)
        self.assertEqual(bucket(129), -bucket(-129))

    def test_position_indices_are_clipped_and_antisymmetric(self):
        c2p, p2c = position_indices()
        self.assertEqual(c2p.shape, (512, 512))
        self.assertTrue(((0 <= c2p) & (c2p <= 511)).all() and ((0 <= p2c) & (p2c <= 511)).all())
        self.assertTrue((np.diag(c2p) == 256).all() and (np.diag(p2c) == 256).all())
        np.testing.assert_array_equal(c2p + p2c, np.full_like(c2p, 512))

    def test_module_map_covers_every_packed_module(self):
        names = q4.modules()
        self.assertEqual(len(names), 6 + 8 * q4.LAYERS)
        self.assertEqual(len(set(names.values())), len(names))


if __name__ == "__main__":
    unittest.main()
