# Explicit manually invoked storage boundary probe, never automatic CTest.
option(AINVR_SEARCH_BUILD_STORAGE_PROBE "Build the opt-in real external-storage interface probe" OFF)
if(AINVR_SEARCH_BUILD_STORAGE_PROBE)
  add_executable(ainvr_search_storage_boundary_probe "${CMAKE_CURRENT_LIST_DIR}/../../test/search/index_storage_boundary_probe.cpp")
  target_link_libraries(ainvr_search_storage_boundary_probe PRIVATE ainvr_search_index_shard_files)
  target_compile_definitions(ainvr_search_storage_boundary_probe PRIVATE
    AINVR_SEARCH_STORAGE_RESULTS_ROOT="${CMAKE_CURRENT_LIST_DIR}/../../test/results")
  target_compile_options(ainvr_search_storage_boundary_probe PRIVATE -Wall -Wextra -Werror)
endif()
