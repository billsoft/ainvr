# One composition of the existing sampler, image stack and HTTP transport.
if(AINVR_S100P AND TARGET ainvr_search_hardware_native)
  add_library(ainvr_search_pipeline
    src/output/search_execution_port.cpp src/output/search_producer_http.cpp)
  target_link_libraries(ainvr_search_pipeline PUBLIC ainvr_search_hardware_native
    ainvr_search_sampling PkgConfig::HTTP OpenSSL::Crypto)
  target_compile_options(ainvr_search_pipeline PRIVATE -Wall -Wextra -Werror)
  target_link_libraries(ainvr_s100p_control_service PRIVATE ainvr_search_pipeline)
endif()

option(AINVR_BUILD_SEARCH_E2E_PROBES "Build manual real-model search integration client" OFF)
if(AINVR_BUILD_SEARCH_E2E_PROBES AND TARGET ainvr_search_pipeline)
  add_executable(ainvr_search_bpu_integration_client ../test/search/bpu_search_integration_client.cpp)
  target_compile_definitions(ainvr_search_bpu_integration_client PRIVATE
    AINVR_SEARCH_PROBE_RESULTS_ROOT="${CMAKE_CURRENT_SOURCE_DIR}/../test/results")
  target_link_libraries(ainvr_search_bpu_integration_client PRIVATE ainvr_search_pipeline ainvr_search_model_package)
  target_compile_options(ainvr_search_bpu_integration_client PRIVATE -Wall -Wextra -Werror)
  set_target_properties(ainvr_search_bpu_integration_client PROPERTIES BUILD_RPATH /usr/hobot/lib)
  # Manual --run-hardware only; never register a hardware CTest automatically.
endif()
