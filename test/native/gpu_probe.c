#define CL_TARGET_OPENCL_VERSION 120
#include <CL/cl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#define OK(call) do { cl_int e=(call); if(e){fprintf(stderr,"%s: %d\n",#call,e);exit(1);} } while(0)
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
int main(void) {
  cl_platform_id platform; cl_device_id device; cl_uint count=0; cl_int e;
  OK(clGetPlatformIDs(1,&platform,&count));
  OK(clGetDeviceIDs(platform,CL_DEVICE_TYPE_GPU,1,&device,&count));
  char name[256],version[256]; cl_uint units,clock;
  OK(clGetDeviceInfo(device,CL_DEVICE_NAME,sizeof(name),name,NULL));
  OK(clGetDeviceInfo(device,CL_DEVICE_VERSION,sizeof(version),version,NULL));
  OK(clGetDeviceInfo(device,CL_DEVICE_MAX_COMPUTE_UNITS,sizeof(units),&units,NULL));
  OK(clGetDeviceInfo(device,CL_DEVICE_MAX_CLOCK_FREQUENCY,sizeof(clock),&clock,NULL));
  printf("HWJSON {\"name\":\"%s\",\"version\":\"%s\",\"compute_units\":%u,\"max_clock_MHz\":%u}\n",name,version,units,clock);
  cl_context ctx=clCreateContext(NULL,1,&device,NULL,NULL,&e); OK(e);
  cl_command_queue queue=clCreateCommandQueue(ctx,device,CL_QUEUE_PROFILING_ENABLE,&e); OK(e);
  const char *src=
    "__kernel void affine(__global const float*a,__global float*b){"
    "int i=get_global_id(0);b[i]=a[i]*2.0f+1.0f;}"
    "__kernel void compute(__global float*b){int i=get_global_id(0);"
    "float4 x=(float4)(0.1f,0.2f,0.3f,0.4f);"
    "for(int j=0;j<1024;j++) x=fma(x,(float4)(0.999f),(float4)(0.001f));"
    "b[i]=x.x+x.y+x.z+x.w;}";
  cl_program program=clCreateProgramWithSource(ctx,1,&src,NULL,&e); OK(e);
  e=clBuildProgram(program,1,&device,"",NULL,NULL);
  if(e){char log[8192];clGetProgramBuildInfo(program,device,CL_PROGRAM_BUILD_LOG,sizeof(log),log,NULL);fprintf(stderr,"%s\n",log);return 1;}
  size_t n=1<<20,bytes=n*sizeof(float),local=64;
  float *a=malloc(bytes),*b=malloc(bytes); if(!a||!b)return 1;
  for(size_t i=0;i<n;i++)a[i]=(float)(i%1024)*0.25f;
  cl_mem aa=clCreateBuffer(ctx,CL_MEM_READ_ONLY,bytes,NULL,&e); OK(e);
  cl_mem bb=clCreateBuffer(ctx,CL_MEM_READ_WRITE,bytes,NULL,&e); OK(e);
  double start=now();OK(clEnqueueWriteBuffer(queue,aa,CL_TRUE,0,bytes,a,0,NULL,NULL));
  double upload=now()-start;
  cl_kernel kernel=clCreateKernel(program,"affine",&e);OK(e);
  OK(clSetKernelArg(kernel,0,sizeof(aa),&aa));OK(clSetKernelArg(kernel,1,sizeof(bb),&bb));
  OK(clEnqueueNDRangeKernel(queue,kernel,1,NULL,&n,&local,0,NULL,NULL));OK(clFinish(queue));
  double device_seconds=0;int loops=30;
  for(int i=0;i<loops;i++){
    cl_event event;cl_ulong s,t;
    OK(clEnqueueNDRangeKernel(queue,kernel,1,NULL,&n,&local,0,NULL,&event));
    OK(clWaitForEvents(1,&event));
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_START,sizeof(s),&s,NULL));
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_END,sizeof(t),&t,NULL));
    if(t<=s)return 1;device_seconds+=(t-s)/1e9;clReleaseEvent(event);
  }
  start=now();OK(clEnqueueReadBuffer(queue,bb,CL_TRUE,0,bytes,b,0,NULL,NULL));
  double download=now()-start;
  for(size_t i=0;i<n;i++)if(fabsf(b[i]-(2*a[i]+1))>1e-5f)return 1;
  printf("HWJSON {\"operation\":\"affine\",\"verified_elements\":%zu,\"kernel_ms_mean\":%.6f,\"kernel_read_write_GBps\":%.3f,\"host_upload_ms\":%.3f,\"host_download_ms\":%.3f}\n",n,device_seconds/loops*1000,2*bytes*(double)loops/device_seconds/1e9,upload*1000,download*1000);
  clReleaseKernel(kernel);
  kernel=clCreateKernel(program,"compute",&e);OK(e);
  OK(clSetKernelArg(kernel,0,sizeof(bb),&bb));
  size_t m=16384;double total=0;loops=8;
  float x[4]={0.1f,0.2f,0.3f,0.4f};
  for(int j=0;j<1024;j++)for(int k=0;k<4;k++)x[k]=fmaf(x[k],0.999f,0.001f);
  float expected=x[0]+x[1]+x[2]+x[3];
  for(int i=0;i<loops+1;i++){
    cl_event event;cl_ulong s,t;
    OK(clEnqueueNDRangeKernel(queue,kernel,1,NULL,&m,&local,0,NULL,&event));OK(clWaitForEvents(1,&event));
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_START,sizeof(s),&s,NULL));
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_END,sizeof(t),&t,NULL));
    if(t<=s)return 1;if(i)total+=(t-s)/1e9;clReleaseEvent(event);
  }
  OK(clEnqueueReadBuffer(queue,bb,CL_TRUE,0,m*sizeof(float),b,0,NULL,NULL));
  for(size_t i=0;i<m;i++)if(!isfinite(b[i])||fabsf(b[i]-expected)>0.002f)return 1;
  printf("HWJSON {\"operation\":\"float4_fma\",\"verified_elements\":%zu,\"kernel_ms_mean\":%.6f,\"GFLOPS\":%.3f,\"note\":\"microbenchmark; not a clpeak-equivalent peak score\"}\n",m,total/loops*1000,m*1024.0*4*2*loops/total/1e9);
  clReleaseKernel(kernel);clReleaseMemObject(aa);clReleaseMemObject(bb);
  clReleaseProgram(program);clReleaseCommandQueue(queue);clReleaseContext(ctx);free(a);free(b);return 0;
}
