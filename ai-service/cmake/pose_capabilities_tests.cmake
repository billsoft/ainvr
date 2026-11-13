# Copyright AINVR. Software tests are separate from explicit model SDK loading.
if(BUILD_TESTING)
  add_executable(pose_decode_test ../test/ai_port/pose_decode_test.cpp)
  target_link_libraries(pose_decode_test PRIVATE ainvr_ai_core GTest::gtest_main)
  add_test(NAME pose_decode COMMAND pose_decode_test)
  set_tests_properties(pose_decode PROPERTIES LABELS software TIMEOUT 15)

  add_executable(pose_contract_test ../test/ai_port/pose_contract_test.cpp)
  target_link_libraries(pose_contract_test PRIVATE ainvr_config GTest::gtest_main)
  add_test(NAME pose_contract COMMAND pose_contract_test)
  set_tests_properties(pose_contract PROPERTIES LABELS software TIMEOUT 15)
endif()

if(TARGET ainvr_reused_worker)
  add_executable(ainvr_model_capabilities_probe EXCLUDE_FROM_ALL ../test/ai_port/model_capabilities_probe.cpp)
  target_link_libraries(ainvr_model_capabilities_probe PRIVATE ainvr_reused_worker)
  set_target_properties(ainvr_model_capabilities_probe PROPERTIES BUILD_RPATH /usr/hobot/lib)
  # Not CTest: --load / --infer take hardware resources. Main runner uses timeout 30s.
endif()
