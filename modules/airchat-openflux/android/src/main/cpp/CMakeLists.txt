cmake_minimum_required(VERSION 3.22.1)

project(openflux_jni C)

# Ядро уже собрано (scripts/build-openflux-android.sh) и лежит там же, откуда
# Gradle упакует его в APK. Пересобирать его тут нечем — Go в Gradle нет, —
# поэтому подключаем как готовую библиотеку, а не как цель сборки.
set(OPENFLUX_CORE ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libopenflux.so)
if(NOT EXISTS ${OPENFLUX_CORE})
  message(FATAL_ERROR "Нет ядра OpenFlux: ${OPENFLUX_CORE}. Собери: bash scripts/build-openflux-android.sh")
endif()

add_library(openflux SHARED IMPORTED)
set_target_properties(openflux PROPERTIES IMPORTED_LOCATION ${OPENFLUX_CORE})

# Обёртка отдельной библиотекой, а не частью ядра: ядро — чужой артефакт,
# который пересобирается своим скриптом, и трогать его сборку ради JNI незачем.
add_library(openflux_jni SHARED openflux_jni.c)
target_include_directories(openflux_jni PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(openflux_jni openflux log)
