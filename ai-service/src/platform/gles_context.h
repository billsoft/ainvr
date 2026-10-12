#ifndef HARDWARE_GLES_CONTEXT_H
#define HARDWARE_GLES_CONTEXT_H
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl31.h>
#include <GLES2/gl2ext.h>
#include <wayland-client.h>
#include <gbm.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {EGLDisplay display;EGLContext context;EGLSurface surface;struct wl_display *wayland;struct gbm_device *gbm;int drm_fd;} hw_gl;
static void hw_json_string(const char *s){
  putchar('"');for(const unsigned char*p=(const unsigned char*)(s?s:"");*p;p++){
    if(*p=='"'||*p=='\\'){putchar('\\');putchar(*p);}else if(*p<32)printf("\\u%04x",*p);else putchar(*p);
  }putchar('"');
}
static int hw_gl_open(hw_gl *g){
  memset(g,0,sizeof(*g));g->drm_fd=-1;g->display=EGL_NO_DISPLAY;g->context=EGL_NO_CONTEXT;g->surface=EGL_NO_SURFACE;
  const char *socket=getenv("HW_WAYLAND_SOCKET");
  PFNEGLGETPLATFORMDISPLAYEXTPROC get_platform=(PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  if(socket){
    g->wayland=wl_display_connect(socket);
    if(!g->wayland){fprintf(stderr,"Wayland connection unavailable: %s\n",socket);return 1;}
    g->display=get_platform?get_platform(EGL_PLATFORM_WAYLAND_EXT,g->wayland,NULL):eglGetDisplay((EGLNativeDisplayType)g->wayland);
  }else{
    const char *device=getenv("AINVR_DRM_RENDER_NODE");if(!device)device="/dev/dri/renderD128";
    g->drm_fd=open(device,O_RDWR|O_CLOEXEC);
    if(g->drm_fd<0){perror("Open DRM render node");return 1;}
    g->gbm=gbm_create_device(g->drm_fd);
    if(!g->gbm){fprintf(stderr,"GBM device unavailable\n");return 1;}
    g->display=get_platform?get_platform(EGL_PLATFORM_GBM_KHR,g->gbm,NULL):eglGetDisplay((EGLNativeDisplayType)g->gbm);
  }
  EGLint major,minor;if(g->display==EGL_NO_DISPLAY||!eglInitialize(g->display,&major,&minor)){fprintf(stderr,"eglInitialize: 0x%x\n",eglGetError());return 1;}
  EGLConfig config;EGLint count;
  EGLint attrs[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_ALPHA_SIZE,8,EGL_NONE};
  if(!eglChooseConfig(g->display,attrs,&config,1,&count)||!count){fprintf(stderr,"No ES3 pbuffer config\n");return 1;}
  if(!eglBindAPI(EGL_OPENGL_ES_API))return 1;
  EGLint ca[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};
  g->context=eglCreateContext(g->display,config,EGL_NO_CONTEXT,ca);
  EGLint pa[]={EGL_WIDTH,16,EGL_HEIGHT,16,EGL_NONE};
  g->surface=eglCreatePbufferSurface(g->display,config,pa);
  if(g->context==EGL_NO_CONTEXT||g->surface==EGL_NO_SURFACE||!eglMakeCurrent(g->display,g->surface,g->surface,g->context)){fprintf(stderr,"EGL context/pbuffer: 0x%x\n",eglGetError());return 1;}
  const char *renderer=(const char*)glGetString(GL_RENDERER);
  if(!renderer||!strstr(renderer,"Mali")){fprintf(stderr,"Hardware Mali renderer required, found %s\n",renderer?renderer:"none");return 1;}
  printf("HWJSON {\"event\":\"gles_driver\",\"vendor\":");hw_json_string((const char*)glGetString(GL_VENDOR));
  printf(",\"renderer\":");hw_json_string(renderer);printf(",\"version\":");hw_json_string((const char*)glGetString(GL_VERSION));
  printf(",\"egl_version\":");hw_json_string(eglQueryString(g->display,EGL_VERSION));
  printf(",\"context\":");hw_json_string(socket?"Wayland offscreen pbuffer":"DRM render node / GBM offscreen pbuffer");printf("}\n");
  return 0;
}
static void hw_gl_close(hw_gl *g){
  if(g->display!=EGL_NO_DISPLAY){eglMakeCurrent(g->display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);if(g->surface!=EGL_NO_SURFACE)eglDestroySurface(g->display,g->surface);if(g->context!=EGL_NO_CONTEXT)eglDestroyContext(g->display,g->context);eglTerminate(g->display);}
  if(g->wayland)wl_display_disconnect(g->wayland);
  if(g->gbm)gbm_device_destroy(g->gbm);
  if(g->drm_fd>=0)close(g->drm_fd);
}
#endif
