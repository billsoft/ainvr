import importlib.util
from pathlib import Path
import unittest
import numpy as np
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('tensor_layout',root/'ai-service/tools/tensor_layout.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TensorTests(unittest.TestCase):
    def test_padding_and_per_axis(self):
        kw=dict(shape=[2,3],strides=[8,1],dtype='int8',aligned_bytes=16,scales=[0.5,1,2],zeros=[1,2,3],axis=1)
        values=np.array([[1,2,4],[-1,-2,-4]],dtype=np.float32)
        raw=m.pack(values,**kw)
        self.assertEqual(raw[3:8],bytes(5));self.assertEqual(raw[11:],bytes(5))
        np.testing.assert_array_equal(m.unpack(raw,**kw),values)
    def test_saturation(self):
        kw=dict(shape=[3],strides=[1],dtype='int8',aligned_bytes=3)
        self.assertEqual(m.pack(np.array([-999,0,999]),**kw),bytes([128,0,127]))
    def test_invalid_layout(self):
        with self.assertRaises(ValueError):m.layout([2,3],[1,1],'uint8',8)
        with self.assertRaises(ValueError):m.layout([2,3],[8,1],'uint8',4)
    def test_invalid_quantization(self):
        with self.assertRaises(ValueError):m.parameters([2,3],[1,2],[],1)
        with self.assertRaises(ValueError):m.parameters([2],[0],[],0)
if __name__=='__main__':unittest.main()
