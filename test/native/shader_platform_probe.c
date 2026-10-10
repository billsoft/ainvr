#include "gles_context.h"
#include <vulkan/vulkan.h>
int main(void){
  hw_gl gl;int failed=hw_gl_open(&gl);
  if(!failed){
    GLint limit;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);printf("HWJSON {\"max_texture_size\":%d,\"timer_query\":%s}\n",limit,strstr((const char*)glGetString(GL_EXTENSIONS),"GL_EXT_disjoint_timer_query")?"true":"false");
    for(int channels=1;channels<=2;channels++){
      GLuint tex,fbo;glGenTextures(1,&tex);glBindTexture(GL_TEXTURE_2D,tex);glTexStorage2D(GL_TEXTURE_2D,1,channels==1?GL_R8:GL_RG8,16,16);
      glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,tex,0);
      GLenum status=glCheckFramebufferStatus(GL_FRAMEBUFFER);unsigned char pixels[16*16*4];glReadPixels(0,0,16,16,channels==1?GL_RED:GL_RG,GL_UNSIGNED_BYTE,pixels);GLenum error=glGetError();
      printf("HWJSON {\"channels\":%d,\"framebuffer_complete\":%s,\"native_readback_error\":%u}\n",channels,status==GL_FRAMEBUFFER_COMPLETE?"true":"false",error);
      glDeleteFramebuffers(1,&fbo);glDeleteTextures(1,&tex);
    }
  }
  hw_gl_close(&gl);
  VkApplicationInfo app={.sType=VK_STRUCTURE_TYPE_APPLICATION_INFO,.pApplicationName="ainvr-resource-probe",.apiVersion=VK_API_VERSION_1_1};
  VkInstanceCreateInfo ci={.sType=VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,.pApplicationInfo=&app};VkInstance instance;
  VkResult r=vkCreateInstance(&ci,NULL,&instance);
  if(r){printf("HWJSON {\"vulkan_create_instance_error\":%d}\n",r);return failed;}
  uint32_t count=0;vkEnumeratePhysicalDevices(instance,&count,NULL);VkPhysicalDevice *devices=calloc(count,sizeof(*devices));vkEnumeratePhysicalDevices(instance,&count,devices);
  for(uint32_t i=0;i<count;i++){VkPhysicalDeviceProperties p;vkGetPhysicalDeviceProperties(devices[i],&p);printf("HWJSON {\"event\":\"vulkan_device\",\"name\":\"%s\",\"api_major\":%u,\"api_minor\":%u,\"api_patch\":%u,\"device_type\":%u}\n",p.deviceName,VK_VERSION_MAJOR(p.apiVersion),VK_VERSION_MINOR(p.apiVersion),VK_VERSION_PATCH(p.apiVersion),p.deviceType);}
  free(devices);vkDestroyInstance(instance,NULL);return failed;
}
