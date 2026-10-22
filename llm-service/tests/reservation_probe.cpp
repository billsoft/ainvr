#include "reservation.hpp"
#include <iostream>
int main(int argc,char** argv){try { ainvr::llm::Reservation r(argv[1],5500000000ULL,512ULL*1024*1024,argc>2?1:8053063680ULL);r.Loaded();std::cout<<"locked"<<std::endl;std::string line;std::getline(std::cin,line);return 0;}catch(const std::exception& e){std::cerr<<e.what();return 2;}}
