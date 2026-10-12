"""AINVR HBM tensor host packing; padding, byte strides and per-axis scales."""
import numpy as np

def layout(shape, strides, dtype, aligned_bytes):
    shape=tuple(shape);strides=tuple(strides);dtype=np.dtype(dtype)
    if not shape or len(shape)!=len(strides) or any(type(x) is not int or x<=0 for x in shape):
        raise ValueError('Invalid shape/strides')
    if any(type(s) is not int or s<0 for s in strides):raise ValueError('Negative/invalid stride')
    required=dtype.itemsize+sum((d-1)*s for d,s in zip(shape,strides))
    if aligned_bytes<required:raise ValueError('Tensor exceeds aligned storage')
    # Reject overlapping elements; permit singleton dimensions with zero stride.
    span=dtype.itemsize
    for stride,dim in sorted((s,d) for s,d in zip(strides,shape) if d>1):
        if stride<span:raise ValueError('Overlapping tensor strides')
        span+=(dim-1)*stride
    return shape,strides,dtype

def parameters(shape, scales, zeros, axis):
    if not scales:return 1.0,0.0
    scales=np.asarray(scales,dtype=np.float64)
    zeros=np.asarray(zeros if zeros else [0],dtype=np.float64)
    if np.any(~np.isfinite(scales)) or np.any(scales<=0):raise ValueError('Invalid quantization scale')
    if scales.size==1 and zeros.size==1:return scales[0],zeros[0]
    if not -len(shape)<=axis<len(shape):raise ValueError('Invalid quantization axis')
    axis%=len(shape)
    if scales.size not in (1,shape[axis]) or zeros.size not in (1,shape[axis]):raise ValueError('Quantization length mismatch')
    dims=[1]*len(shape);dims[axis]=shape[axis]
    return (scales.reshape(dims) if scales.size>1 else scales[0],zeros.reshape(dims) if zeros.size>1 else zeros[0])

def pack(values, *, shape, strides, dtype, aligned_bytes, scales=(), zeros=(), axis=0):
    shape,strides,dtype=layout(shape,strides,dtype,aligned_bytes)
    values=np.asarray(values)
    if values.shape!=shape:raise ValueError('Input shape mismatch')
    if np.any(~np.isfinite(values)):raise ValueError('Nonfinite input')
    scale,zero=parameters(shape,scales,zeros,axis)
    if np.issubdtype(dtype,np.integer):
        limits=np.iinfo(dtype);values=np.clip(np.rint(values/scale+zero),limits.min,limits.max)
    elif scales:raise ValueError('Quantization on floating point tensor')
    buffer=bytearray(aligned_bytes)
    np.ndarray(shape,dtype=dtype,buffer=buffer,strides=strides)[...]=values
    return bytes(buffer)

def unpack(buffer, *, shape, strides, dtype, aligned_bytes, scales=(), zeros=(), axis=0):
    shape,strides,dtype=layout(shape,strides,dtype,aligned_bytes)
    if len(buffer)!=aligned_bytes:raise ValueError('Output buffer size mismatch')
    values=np.ndarray(shape,dtype=dtype,buffer=buffer,strides=strides).astype(np.float64)
    scale,zero=parameters(shape,scales,zeros,axis)
    return ((values-zero)*scale).astype(np.float32)
