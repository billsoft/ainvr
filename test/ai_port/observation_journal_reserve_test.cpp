#define main original_journal_test_main
#include "observation_journal_test.cpp"
#undef main

int main(int argc,char** argv){
 assert(argc==2);
 ObservationJournal journal(argv[1],"processor",64*1024*1024,10000,std::numeric_limits<uintmax_t>::max());
 const auto before=journal.Status();
 bool rejected=false;
 try{journal.Stage(sample(1));}catch(const std::runtime_error& e){rejected=std::string(e.what()).find("reserve")!=std::string::npos;}
 assert(rejected);
 assert(journal.Status().at("next_offset")==before.at("next_offset"));
 assert(journal.Status().at("pending_upper_bound")==0);
 assert(journal.Status().at("full_rejections")==1);
 std::cout<<"System disk reserve rejects observation without consuming identity PASS\n";
}
