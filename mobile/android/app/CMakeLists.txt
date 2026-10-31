cmake_minimum_required(VERSION 3.22.1)

# Node 24's V8 headers require C++20 (they use concepts and constrained
# templates in v8-local-handle.h). This must be set before any target is
# created, and it only affects this shim — libnode.so is prebuilt.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

project(openmaic-mobile)

# LIBNODE_DIR is passed by Gradle: the directory the nodejs-mobile release zip
# unpacks to (bin/<abi>/libnode.so + include/node).
if(NOT DEFINED LIBNODE_DIR)
    message(FATAL_ERROR "LIBNODE_DIR must be defined")
endif()

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
    IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(openmaic-node SHARED src/main/cpp/node_jni.cpp)

target_include_directories(openmaic-node PRIVATE ${LIBNODE_DIR}/include/node)

# Android requires every shared library to be 16 KB page aligned to install on
# devices with 16 KB memory pages (Android 15+ on arm64). nodejs-mobile's
# Android builds are already built this way; this keeps the JNI shim matching.
target_link_options(openmaic-node PRIVATE "-Wl,-z,max-page-size=16384")

# libnode.so exports the C++ runtime symbols it was built against, and AGP links
# the C++ shared runtime by default. Linking it explicitly keeps the JNI shim and
# libnode on one runtime rather than two.
target_link_libraries(openmaic-node libnode c++_shared)

find_library(log-lib log)
target_link_libraries(openmaic-node ${log-lib})
