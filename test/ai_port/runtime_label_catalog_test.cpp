#include "adapters/runtime_label_catalog.hpp"
#include <cassert>
#include <iostream>
using ai_service::adapters::RuntimeLabelCatalog;
int main(){
 ai_service::config::ModelConfig c;
 auto fixed=RuntimeLabelCatalog(c,{"person","car"});
 assert(fixed["labels"][1]["label_id"]=="class:1");assert(fixed["labels"][0]["name"]=="person");
 c.adapter="yoloe_bpu";c.label_id="target";c.label_name="Display";
 auto single=RuntimeLabelCatalog(c,{"red car"});assert(single["labels"][0]["label_id"]=="target");assert(single["labels"][0]["name"]=="Display");
 auto multi=RuntimeLabelCatalog(c,{"red car","person"});assert(multi["labels"][1]["label_id"]=="target:1");assert(multi["labels"][1]["name"]=="person");
 c.prompts={{"walking person","person-stable","行人"},{"red vehicle","car-stable","红车"}};
 auto prompted=RuntimeLabelCatalog(c,{});assert(prompted["labels"][1]["label_id"]=="car-stable");
 std::swap(c.prompts[0],c.prompts[1]);auto swapped=RuntimeLabelCatalog(c,{});assert(swapped["labels"][0]["label_id"]=="car-stable");
 c.adapter="locateanything_bpu";c.prompts[0].label_name="";
 auto locate=RuntimeLabelCatalog(c,{});assert(locate["labels"][0]["name"]=="red vehicle");
 c.prompts.clear();c.label_id="";c.label_name="";c.description="fire";
 auto fallback=RuntimeLabelCatalog(c,{});assert(fallback["labels"][0]["label_id"]=="class:0");assert(fallback["labels"][0]["name"]=="fire");
 std::cout<<"runtime label catalog cases passed\n";
}