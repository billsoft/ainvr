#define CL_TARGET_OPENCL_VERSION 120
#include <CL/cl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#define OK(call) do{cl_int r=(call);if(r){fprintf(stderr,"%s: %d\n",#call,r);return 1;}}while(0)
static double mono(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
static void reference(const unsigned char *a,unsigned char *b,int w,int h){
  int ow=w/2,oh=h/2;
  for(int y=0;y<oh;y++)for(int x=0;x<ow;x++){
    size_t p=(size_t)(2*y)*w+2*x;
    b[(size_t)y*ow+x]=(a[p]+a[p+1]+a[p+w]+a[p+w+1]+2)>>2;
    if(y<oh/2){p=(size_t)w*h+(size_t)(2*y)*w+4*(x/2)+(x&1);
      b[(size_t)ow*oh+(size_t)y*ow+x]=(a[p]+a[p+2]+a[p+w]+a[p+w+2]+2)>>2;}
  }
}
static int cmp(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
int main(int argc,char **argv){
  if(argc!=4)return 2;int w=atoi(argv[1]),h=atoi(argv[2]),n=atoi(argv[3]);
  if(w<32||h<32||w%4||h%4||w>8192||h>8192||n<1||n>1000)return 2;
  size_t inbytes=(size_t)w*h*3/2,outbytes=inbytes/4;
  unsigned char *a=malloc(inbytes),*b=malloc(outbytes),*expected=malloc(outbytes);
  double *times=calloc(n,sizeof(double));if(!a||!b||!expected||!times)return 1;
  for(int y=0;y<h;y++)for(int x=0;x<w;x++)a[(size_t)y*w+x]=(x*13+y*7+(x>>3)+(y>>2))&255;
  for(int y=0;y<h/2;y++)for(int x=0;x<w;x++)a[(size_t)w*h+(size_t)y*w+x]=(x*11+y*3+(x&1)*31)&255;
  double start=mono();int cpu_loops=n<12?n:12;
  for(int i=0;i<cpu_loops;i++){reference(a,expected,w,h);__asm__ volatile(""::"r"(expected):"memory");}
  double cpu=mono()-start;
  printf("HWJSON {\"operation\":\"CPU-single-core-NV12-half-scale\",\"width\":%d,\"height\":%d,\"latency_ms_mean\":%.3f,\"sequential_fps\":%.3f,\"frames\":%d,\"note\":\"scalar C reference; no explicit NEON or multi-core optimization\"}\n",w,h,cpu/cpu_loops*1000,cpu_loops/cpu,cpu_loops);
  cl_platform_id platform;cl_device_id device;cl_uint count;cl_int e;
  OK(clGetPlatformIDs(1,&platform,&count));OK(clGetDeviceIDs(platform,CL_DEVICE_TYPE_GPU,1,&device,&count));
  char name[256];OK(clGetDeviceInfo(device,CL_DEVICE_NAME,sizeof(name),name,NULL));
  cl_context ctx=clCreateContext(NULL,1,&device,NULL,NULL,&e);OK(e);
  cl_command_queue q=clCreateCommandQueue(ctx,device,CL_QUEUE_PROFILING_ENABLE,&e);OK(e);
  const char *src="__kernel void halfscale(__global const uchar*a,__global uchar*b,int w,int h){"
    "int x=get_global_id(0),y=get_global_id(1),ow=w/2,oh=h/2;"
    "if(x>=ow||y>=oh)return;int p=2*y*w+2*x;"
    "b[y*ow+x]=(a[p]+a[p+1]+a[p+w]+a[p+w+1]+2)>>2;"
    "if(y<oh/2){p=w*h+2*y*w+4*(x/2)+(x&1);"
    "b[ow*oh+y*ow+x]=(a[p]+a[p+2]+a[p+w]+a[p+w+2]+2)>>2;}}";
  cl_program program=clCreateProgramWithSource(ctx,1,&src,NULL,&e);OK(e);
  e=clBuildProgram(program,1,&device,"",NULL,NULL);if(e){char log[8192];clGetProgramBuildInfo(program,device,CL_PROGRAM_BUILD_LOG,sizeof(log),log,NULL);fprintf(stderr,"%s\n",log);return 1;}
  cl_kernel k=clCreateKernel(program,"halfscale",&e);OK(e);
  cl_mem input=clCreateBuffer(ctx,CL_MEM_READ_ONLY,inbytes,NULL,&e);OK(e);
  cl_mem output=clCreateBuffer(ctx,CL_MEM_WRITE_ONLY,outbytes,NULL,&e);OK(e);
  OK(clSetKernelArg(k,0,sizeof(input),&input));OK(clSetKernelArg(k,1,sizeof(output),&output));
  OK(clSetKernelArg(k,2,sizeof(w),&w));OK(clSetKernelArg(k,3,sizeof(h),&h));
  size_t global[2]={(size_t)w/2,(size_t)h/2};double kernels=0,total=0;
  for(int i=-3;i<n;i++){
    start=mono();cl_event event;cl_ulong t0,t1;
    OK(clEnqueueWriteBuffer(q,input,CL_TRUE,0,inbytes,a,0,NULL,NULL));
    OK(clEnqueueNDRangeKernel(q,k,2,NULL,global,NULL,0,NULL,&event));
    OK(clEnqueueReadBuffer(q,output,CL_TRUE,0,outbytes,b,0,NULL,NULL));
    double elapsed=mono()-start;
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_START,sizeof(t0),&t0,NULL));
    OK(clGetEventProfilingInfo(event,CL_PROFILING_COMMAND_END,sizeof(t1),&t1,NULL));clReleaseEvent(event);
    if(i==0||i==n-1)if(memcmp(b,expected,outbytes)){fprintf(stderr,"NV12 differs from CPU reference\n");return 1;}
    if(i>=0){times[i]=elapsed;total+=elapsed;kernels+=(t1-t0)/1e9;}
  }
  qsort(times,n,sizeof(double),cmp);
  printf("HWJSON {\"operation\":\"GPU-NV12-half-scale\",\"device\":\"%s\",\"input_width\":%d,\"input_height\":%d,\"output_width\":%d,\"output_height\":%d,\"completed_frames\":%d,\"kernel_ms_mean\":%.3f,\"kernel_fps\":%.3f,\"upload_kernel_download_ms_mean\":%.3f,\"upload_kernel_download_ms_p95\":%.3f,\"upload_kernel_download_fps\":%.3f,\"verified_bytes\":%zu,\"timing\":\"preallocated buffers; CPU to GPU upload and GPU to CPU download each frame; excludes decode and allocation\",\"filter\":\"2x2 box; NV12 chroma preserved\"}\n",name,w,h,w/2,h/2,n,kernels/n*1000,n/kernels,total/n*1000,times[(n-1)*95/100]*1000,n/total,outbytes);
  clReleaseMemObject(input);clReleaseMemObject(output);clReleaseKernel(k);clReleaseProgram(program);clReleaseCommandQueue(q);clReleaseContext(ctx);free(a);free(b);free(expected);free(times);return 0;
}
