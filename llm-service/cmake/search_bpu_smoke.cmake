# Manual Qwen search verification smoke; no model loads during build/CTest.
option(AINVR_LLM_BUILD_SEARCH_BPU_SMOKE "Build opt-in bounded Qwen search BPU smoke" OFF)
if(AINVR_LLM_BUILD_SEARCH_BPU_SMOKE)
 add_executable(ainvr_llm_submission_budget_test "${CMAKE_CURRENT_LIST_DIR}/../../test/search/llm_submission_budget_test.cpp")
 target_include_directories(ainvr_llm_submission_budget_test PRIVATE "${CMAKE_CURRENT_LIST_DIR}/../src")
 target_compile_options(ainvr_llm_submission_budget_test PRIVATE -Wall -Wextra -Werror)
 add_executable(ainvr_llm_search_bpu_smoke "${CMAKE_CURRENT_LIST_DIR}/../../test/search/llm_search_bpu_smoke.cpp")
 target_link_libraries(ainvr_llm_search_bpu_smoke PRIVATE ainvr_llm_engine ainvr_llm_image)
 target_compile_definitions(ainvr_llm_search_bpu_smoke PRIVATE
   AINVR_SEARCH_LLM_RESULTS_ROOT="${CMAKE_CURRENT_LIST_DIR}/../../test/results")
 target_compile_options(ainvr_llm_search_bpu_smoke PRIVATE -idirafter /usr/hobot/include -Wall -Wextra -Werror)
 set_target_properties(ainvr_llm_search_bpu_smoke PROPERTIES BUILD_RPATH /usr/hobot/lib)
endif()
