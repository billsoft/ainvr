"""FLOAT32 stable softmax graph; polynomial exp and normalized integer seed.

Centered values below-32 are zeroed (tail <= columns*exp(-32)). This does
not change box/confidence thresholds. All math must be compiled on BPU.
"""
import math
from hbdk4.compiler import leap
from locateanything_normalized_rsqrt_bpu import rsqrt_positive_bpu

def softmax_float_bpu(scores):
    scores=leap.cast_type(scores,output_type=leap.float32)
    shape=list(scores.type.shape);rows=shape[:-1]+[1]
    maximum=leap.reshape(leap.reduce_max(scores,[-1]),rows)
    centered=leap.add(scores,leap.mul(maximum,-1.))
    keep=leap.cast_type(leap.greater_equal(centered,-32.),output_type=leap.float32)
    discard=leap.add(1.,leap.mul(keep,-1.))
    clipped=leap.add(leap.mul(keep,centered),leap.mul(discard,-32.))
    t=leap.mul(clipped,1/32.)
    exponential=leap.add(leap.mul(t,1/math.factorial(12)),1/math.factorial(11))
    for k in range(10,-1,-1):
        exponential=leap.add(leap.mul(exponential,t),1/math.factorial(k))
    for _ in range(5):exponential=leap.mul(exponential,exponential)
    exponential=leap.mul(exponential,keep)
    total=leap.mul(leap.reshape(leap.reduce_mean(exponential,[-1]),rows),float(shape[-1]))
    inverse=rsqrt_positive_bpu(total)
    reciprocal=leap.mul(inverse,inverse)
    return leap.mul(exponential,reciprocal)
