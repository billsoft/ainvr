# Copyright AINVR. Original worker business; S100P hardware executes behind adapters.
if(AINVR_S100P)
  add_library(ainvr_reused_worker src/pipeline/reused_channel_worker.cpp
    src/adapters/bpu_channel_adapter.cpp src/utils/user_facing_error.cpp)
  target_link_libraries(ainvr_reused_worker PUBLIC ainvr_reused_controller ainvr_stream_source ainvr_bpu_images)
  target_link_libraries(ainvr_s100p_control_service PRIVATE ainvr_reused_worker)
  target_sources(ainvr_s100p_control_service PRIVATE src/utils/crash_handler.cpp)
  if(BUILD_TESTING)
    # Explicitly built hardware probes require CLI resources and are not
    # automatic ctest jobs; they never change a production channel themselves.
    foreach(pair IN ITEMS
        "ainvr_throughput_probe;throughput_probe.cpp"
        "ainvr_bpu_pipeline_probe;bpu_pipeline_probe.cpp"
        "ainvr_yoloe_channel_adapter_probe;yoloe_channel_adapter_probe.cpp"
        "ainvr_yoloe_reused_archive_probe;yoloe_reused_archive_probe.cpp"
        "ainvr_read_yoloe_live_sei;read_yoloe_live_sei.cpp"
        "ainvr_yoloe_decode_probe;yoloe_decode_output_probe.cpp"
        "ainvr_yoloe_prompt_probe;yoloe_bpu_prompt_probe.cpp"
        "ainvr_yoloe_text_probe;yoloe_bpu_text_probe.cpp"
        "ainvr_yoloe_tensor_probe;yoloe_bpu_tensor_probe.cpp")
      list(GET pair 0 probe)
      list(GET pair 1 source)
      add_executable(${probe} ../test/ai_port/${source})
      target_link_libraries(${probe} PRIVATE ainvr_reused_worker)
      set_target_properties(${probe} PROPERTIES BUILD_RPATH /usr/hobot/lib)
    endforeach()
    add_executable(crash_handler_test ../test/ai_port/crash_handler_test.cpp src/utils/crash_handler.cpp)
    target_include_directories(crash_handler_test PRIVATE src)
    target_link_libraries(crash_handler_test PRIVATE GTest::gtest_main)
    add_test(NAME crash_handler COMMAND crash_handler_test)
    set_tests_properties(crash_handler PROPERTIES TIMEOUT 30 RUN_SERIAL TRUE)
    add_executable(systemd_watchdog_test ../test/ai_port/systemd_watchdog_test.cpp)
    target_include_directories(systemd_watchdog_test PRIVATE src)
    target_link_libraries(systemd_watchdog_test PRIVATE GTest::gtest_main)
    add_test(NAME systemd_watchdog COMMAND systemd_watchdog_test)
    set_tests_properties(systemd_watchdog PROPERTIES TIMEOUT 30 RUN_SERIAL TRUE)
    add_executable(reused_worker_test ../test/ai_port/reused_worker_test.cpp)
    target_link_libraries(reused_worker_test PRIVATE ainvr_reused_worker GTest::gtest_main)
    set_target_properties(reused_worker_test PROPERTIES BUILD_RPATH /usr/hobot/lib)
    add_test(NAME reused_worker COMMAND reused_worker_test)
    set_tests_properties(reused_worker PROPERTIES LABELS hardware TIMEOUT 90 RUN_SERIAL TRUE)
    # Explicit hardware proof; never run by ctest or modify production config.
    add_executable(locateanything_reused_sei_archive_probe_v3 ../test/ai_port/locateanything_reused_sei_archive_probe_v3.cpp)
    target_link_libraries(locateanything_reused_sei_archive_probe_v3 PRIVATE ainvr_reused_worker)
    set_target_properties(locateanything_reused_sei_archive_probe_v3 PROPERTIES BUILD_RPATH /usr/hobot/lib)
    add_executable(locateanything_channel_lease_test ../test/ai_port/locateanything_channel_lease_test.cpp)
    target_include_directories(locateanything_channel_lease_test PRIVATE src)
    target_link_libraries(locateanything_channel_lease_test PRIVATE Threads::Threads)
    add_test(NAME locateanything_channel_lease COMMAND locateanything_channel_lease_test)
    set_tests_properties(locateanything_channel_lease PROPERTIES TIMEOUT 20)
    add_executable(locateanything_adapter_test ../test/ai_port/locateanything_adapter_test.cpp)
    target_link_libraries(locateanything_adapter_test PRIVATE ainvr_reused_worker)
    set_target_properties(locateanything_adapter_test PROPERTIES BUILD_RPATH /usr/hobot/lib)
    add_test(NAME locateanything_adapter COMMAND locateanything_adapter_test
      ${CMAKE_CURRENT_SOURCE_DIR}/../test/results/locateanything-geometry-fixtures-v1.json)
    set_tests_properties(locateanything_adapter PROPERTIES TIMEOUT 20)
    add_executable(locateanything_multicategory_test ../test/ai_port/locateanything_multicategory_test.cpp)
    target_link_libraries(locateanything_multicategory_test PRIVATE ainvr_reused_worker)
    set_target_properties(locateanything_multicategory_test PROPERTIES BUILD_RPATH /usr/hobot/lib)
    add_test(NAME locateanything_multicategory COMMAND locateanything_multicategory_test
      ${CMAKE_CURRENT_SOURCE_DIR}/../test/results/locateanything-multicategory-fixture-v326.json)
    set_tests_properties(locateanything_multicategory PROPERTIES TIMEOUT 20)
    add_executable(nv12_rgba_test ../test/ai_port/nv12_rgba_test.cpp)
    target_include_directories(nv12_rgba_test PRIVATE src/platform)
    target_link_libraries(nv12_rgba_test PRIVATE ainvr_gles GTest::gtest_main)
    set_target_properties(nv12_rgba_test PROPERTIES BUILD_RPATH /usr/hobot/lib)
    add_test(NAME nv12_rgba COMMAND nv12_rgba_test)
    set_tests_properties(nv12_rgba PROPERTIES LABELS hardware TIMEOUT 90 RUN_SERIAL TRUE)
  endif()
endif()
