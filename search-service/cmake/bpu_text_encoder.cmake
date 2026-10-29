# Include after existing HTTP/model-package/tokenizer targets. This adds no
# runtime instance and does not enable search, acquire /run locks or load HBM.
if(NOT TARGET ainvr_search_tokenizer OR NOT TARGET ainvr_search_model_package OR NOT TARGET ainvr_search_http)
  message(FATAL_ERROR "Build the existing search tokenizer/model/HTTP targets first")
endif()
set(AINVR_SEARCH_ROOT "${CMAKE_CURRENT_LIST_DIR}/..")
set(AINVR_PLATFORM_ROOT "${AINVR_SEARCH_ROOT}/../ai-service/src/platform")
find_library(AINVR_TEXT_DNN dnn PATHS /usr/hobot/lib REQUIRED NO_DEFAULT_PATH)
find_library(AINVR_TEXT_UCP hbucp PATHS /usr/hobot/lib REQUIRED NO_DEFAULT_PATH)
find_library(AINVR_TEXT_HBMEM hbmem PATHS /usr/hobot/lib REQUIRED NO_DEFAULT_PATH)
add_library(ainvr_search_bpu_text_contract
  "${AINVR_SEARCH_ROOT}/src/bpu_text_encoder_contract.cpp"
  "${AINVR_PLATFORM_ROOT}/bpu_image_input.cpp"
  "${AINVR_PLATFORM_ROOT}/tensor_decode.cpp")
target_include_directories(ainvr_search_bpu_text_contract PUBLIC "${AINVR_SEARCH_ROOT}/src")
target_include_directories(ainvr_search_bpu_text_contract SYSTEM PRIVATE /usr/include/hobot)
target_link_libraries(ainvr_search_bpu_text_contract PUBLIC ainvr_search_model_package ainvr_search_http)
target_compile_options(ainvr_search_bpu_text_contract PRIVATE -Wall -Wextra -Werror)
add_library(ainvr_search_bpu_text_encoder
  "${AINVR_SEARCH_ROOT}/src/bpu_text_encoder.cpp" "${AINVR_PLATFORM_ROOT}/bpu.cpp")
target_include_directories(ainvr_search_bpu_text_encoder SYSTEM PRIVATE /usr/include/hobot)
target_compile_options(ainvr_search_bpu_text_encoder PRIVATE -idirafter /usr/hobot/include)
target_link_libraries(ainvr_search_bpu_text_encoder PUBLIC ainvr_search_bpu_text_contract ainvr_search_tokenizer
  ${AINVR_TEXT_DNN} ${AINVR_TEXT_UCP} ${AINVR_TEXT_HBMEM})
target_compile_options(ainvr_search_bpu_text_encoder PRIVATE -Wall -Wextra -Werror)
add_executable(ainvr_search_bpu_text_contract_test "${AINVR_SEARCH_ROOT}/tests/bpu_text_encoder_contract_test.cpp")
target_include_directories(ainvr_search_bpu_text_contract_test SYSTEM PRIVATE /usr/include/hobot)
target_link_libraries(ainvr_search_bpu_text_contract_test PRIVATE ainvr_search_bpu_text_contract)
target_compile_options(ainvr_search_bpu_text_contract_test PRIVATE -Wall -Wextra -Werror)
add_test(NAME search_bpu_text_software_contract COMMAND ainvr_search_bpu_text_contract_test)
set_tests_properties(search_bpu_text_software_contract PROPERTIES TIMEOUT 15)
add_executable(ainvr_search_bpu_reservation_test "${AINVR_SEARCH_ROOT}/tests/bpu_reservation_test.cpp")
target_link_libraries(ainvr_search_bpu_reservation_test PRIVATE nlohmann_json::nlohmann_json)
target_compile_options(ainvr_search_bpu_reservation_test PRIVATE -Wall -Wextra -Werror)
add_test(NAME search_bpu_coexist_reservation COMMAND ainvr_search_bpu_reservation_test)
set_tests_properties(search_bpu_coexist_reservation PROPERTIES TIMEOUT 10)
