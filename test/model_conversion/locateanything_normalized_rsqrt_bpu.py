"""Positive FLOAT32 variance, normalized INT16 Rsqrt seed, FLOAT32 refinement.

Graph operations only. Declared input range2^-24 <= x <2^18; layer epsilons
keep zero-variance inputs positive. This helper still needs actual BPU proof.
"""
import math
import torch
from hbdk4.compiler import leap

def rsqrt_positive_bpu(value):
    shape=list(value.type.shape)
    value=leap.reshape(leap.cast_type(value,output_type=leap.float32),[math.prod(shape)])
    normalized=leap.mul(value,float(2.**24))
    factor=torch.full([math.prod(shape)],float(2.**12),dtype=torch.float32)
    # Even exponent shifts leave normalized positive variance in[1,4).
    for shift in [32,16,8,4,2]:
        flag=leap.cast_type(leap.greater_equal(normalized,float(2.**shift)),output_type=leap.float32)
        inverse_flag=leap.add(1.,leap.mul(flag,-1.))
        normalized=leap.add(leap.mul(flag,leap.mul(normalized,float(2.**-shift))),leap.mul(inverse_flag,normalized))
        factor=leap.add(leap.mul(flag,leap.mul(factor,float(2.**(-shift/2)))),leap.mul(inverse_flag,factor))
    lookup=leap.const_fake_quant(normalized,[-4.],[4.],16,True)
    inverse=leap.cast_type(leap.const_fake_quant(leap.rsqrt(lookup),[-2.],[2.],16,True),output_type=leap.float32)
    for _ in range(2):
        correction=leap.add(1.5,leap.mul(leap.mul(normalized,leap.mul(inverse,inverse)),-.5))
        inverse=leap.mul(inverse,correction)
    return leap.reshape(leap.mul(inverse,factor),shape)
