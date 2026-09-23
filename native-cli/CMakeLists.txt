cmake_minimum_required(VERSION 3.24)
project(deckard VERSION 0.7.0 LANGUAGES CXX)
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux" OR NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64|aarch64|arm64)$")
  message(FATAL_ERROR "Deckard's ONNX Runtime backend requires Linux on x86_64 or aarch64.")
endif()
if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|AMD64)$")
  set(RUST_TRIPLE "x86_64-unknown-linux-gnu")
  set(ORT_ARCH "x64")
else()
  set(RUST_TRIPLE "aarch64-unknown-linux-gnu")
  set(ORT_ARCH "aarch64")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin")
get_filename_component(AI_HIDER_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
if(DEFINED ENV{NATIVE_CACHE})
  set(NATIVE_CACHE "$ENV{NATIVE_CACHE}" CACHE PATH "Native dependency cache")
else()
  set(NATIVE_CACHE "${AI_HIDER_ROOT}/cache/native-build" CACHE PATH "Native dependency cache")
endif()
add_library(ai_hider_json INTERFACE)
target_include_directories(ai_hider_json INTERFACE "${NATIVE_CACHE}/json/include")

set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/model-assets.json")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/model-assets.json" MODEL_ASSETS_JSON)
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/model-assets.json" MODEL_ASSETS_SHA256)
configure_file(src/model_assets.hpp.in "${CMAKE_CURRENT_BINARY_DIR}/generated/model_assets.hpp" @ONLY)

# Pinned prebuilt ONNX Runtime (MIT), fetched and checksum-verified by bootstrap.sh.
set(ORT_ROOT "${NATIVE_CACHE}/onnxruntime/onnxruntime-linux-${ORT_ARCH}-1.22.0")
if(NOT EXISTS "${ORT_ROOT}/lib/libonnxruntime.so.1.22.0" OR NOT EXISTS "${ORT_ROOT}/include/onnxruntime_cxx_api.h")
  message(FATAL_ERROR "ONNX Runtime 1.22.0 is missing from ${NATIVE_CACHE}; run native-cli/bootstrap.sh.")
endif()
add_library(onnxruntime SHARED IMPORTED)
set_target_properties(onnxruntime PROPERTIES
  IMPORTED_LOCATION "${ORT_ROOT}/lib/libonnxruntime.so.1.22.0"
  IMPORTED_SONAME "libonnxruntime.so.1"
  INTERFACE_INCLUDE_DIRECTORIES "${ORT_ROOT}/include")

set(RUST_TOOLCHAIN "${NATIVE_CACHE}/rustup/toolchains/1.90.0-${RUST_TRIPLE}")
set(CARGO "${RUST_TOOLCHAIN}/bin/cargo" CACHE FILEPATH "Cargo executable")
set(BUILD_CARGO_HOME "${CMAKE_CURRENT_BINARY_DIR}/cargo")
file(MAKE_DIRECTORY "${BUILD_CARGO_HOME}")
# Cargo may update lock/cache metadata even offline. Never point CARGO_HOME at
# the shared SDK: keep its registry snapshot in the writable build directory.
file(COPY "${NATIVE_CACHE}/cargo/registry" DESTINATION "${BUILD_CARGO_HOME}")
set(RUST_TARGET "${CMAKE_CURRENT_BINARY_DIR}/rust")
string(ASCII 31 RUST_FLAG_SEPARATOR)
set(RUST_PATH_FLAGS "--remap-path-prefix=${AI_HIDER_ROOT}=/deckard-source${RUST_FLAG_SEPARATOR}--remap-path-prefix=${NATIVE_CACHE}=/deckard-sdk")
add_custom_command(
  OUTPUT "${RUST_TARGET}/release/libai_hider_tokenizer.a"
  COMMAND "${CMAKE_COMMAND}" -E env
    "CARGO_HOME=${BUILD_CARGO_HOME}" "RUSTUP_HOME=${NATIVE_CACHE}/rustup"
    "RUSTC=${RUST_TOOLCHAIN}/bin/rustc"
    "CARGO_ENCODED_RUSTFLAGS=${RUST_PATH_FLAGS}"
    "RUSTUP_TOOLCHAIN=1.90.0" "CARGO_TARGET_DIR=${RUST_TARGET}" "CARGO_BUILD_JOBS=2"
    "${CARGO}" build --release --locked --offline --manifest-path "${CMAKE_CURRENT_SOURCE_DIR}/tokenizer/Cargo.toml"
  DEPENDS tokenizer/Cargo.toml tokenizer/Cargo.lock tokenizer/src/lib.rs
  VERBATIM)
add_custom_target(tokenizer_build DEPENDS "${RUST_TARGET}/release/libai_hider_tokenizer.a")
add_library(tokenizer_native STATIC IMPORTED)
set_target_properties(tokenizer_native PROPERTIES IMPORTED_LOCATION "${RUST_TARGET}/release/libai_hider_tokenizer.a")
add_dependencies(tokenizer_native tokenizer_build)
add_custom_target(dependency_notices ALL
  COMMAND "${CMAKE_COMMAND}" "-DNATIVE_CACHE=${NATIVE_CACHE}"
    "-DTOKENIZER_DIR=${CMAKE_CURRENT_SOURCE_DIR}/tokenizer"
    "-DRUST_TOOLCHAIN=${RUST_TOOLCHAIN}" "-DORT_ROOT=${ORT_ROOT}"
    "-DDESTINATION=${CMAKE_CURRENT_BINARY_DIR}/licenses"
    -P "${CMAKE_CURRENT_SOURCE_DIR}/collect-licenses.cmake"
  DEPENDS tokenizer_build VERBATIM)

add_executable(deckard src/main.cpp src/onnx_gradient.cpp src/tokenizer.cpp src/support.cpp src/host.cpp src/setup.cpp)
target_include_directories(deckard PRIVATE src "${CMAKE_CURRENT_BINARY_DIR}/generated")
target_compile_options(deckard PRIVATE -Wall -Wextra
  "-ffile-prefix-map=${AI_HIDER_ROOT}=/deckard-source"
  "-ffile-prefix-map=${NATIVE_CACHE}=/deckard-sdk")
target_link_libraries(deckard PRIVATE tokenizer_native ai_hider_json onnxruntime pthread dl m)
# The release keeps its own ONNX Runtime copy beside the executable.
set_target_properties(deckard PROPERTIES BUILD_RPATH "${ORT_ROOT}/lib" INSTALL_RPATH "$ORIGIN/../lib")
install(TARGETS deckard RUNTIME DESTINATION bin)
# Installed as a regular file under its SONAME: releases never contain library symlinks.
install(FILES "${ORT_ROOT}/lib/libonnxruntime.so.1.22.0" DESTINATION lib RENAME libonnxruntime.so.1)
install(DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/licenses/" DESTINATION share/licenses)

enable_testing()
add_executable(deckard-process-metrics tests/process-metrics.cpp)
add_test(NAME cli_help COMMAND deckard --help)
add_test(NAME native_unit COMMAND deckard self-test)
