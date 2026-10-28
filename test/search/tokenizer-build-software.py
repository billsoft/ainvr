#!/usr/bin/env python3
"""Build only tokenizer software in a private shadow; no BPU, pip or install to /usr.

First-party callers can reuse work/source/sentencepiece and work/prefix for the
same pinned targets. Upstream tokenizers-cpp and its submodule remain read only.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


def run(*args):
    subprocess.run([str(x) for x in args], check=True)


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path('/mnt/ainvr-ssd/llm-build/third_party/tokenizers-cpp'))
    parser.add_argument('--work', type=Path, default=root/'out/search-tokenizer-software')
    parser.add_argument('--jobs', type=int, default=2, choices=[1, 2])
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    sp = source/'sentencepiece'
    lock = json.loads((root/'test/search/tokenizer-dependencies.lock.json').read_text())
    for directory, commit in [(source, lock['tokenizers_cpp']['commit']), (sp, lock['sentencepiece']['commit'])]:
        actual = subprocess.check_output(['git', '-C', str(directory), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != commit:
            raise RuntimeError('Pinned tokenizer source commit mismatch')
        subprocess.run(['git', '-C', str(directory), 'diff', '--quiet', 'HEAD', '--'], check=True)
    work = args.work.resolve()
    if root not in work.parents or work == root or source == work or source in work.parents:
        raise RuntimeError('Work directory must be private under the repository, outside readonly dependencies')
    work.mkdir(parents=True, exist_ok=True)
    downloads = work/'downloads'; downloads.mkdir(exist_ok=True)
    archive = downloads/'abseil-20260107.1.tar.gz'
    if not archive.exists():
        temporary = archive.with_suffix('.download')
        with urllib.request.urlopen(lock['abseil']['url'], timeout=60) as response, temporary.open('xb') as target:
            shutil.copyfileobj(response, target)
        temporary.rename(archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != lock['abseil']['sha256']:
        raise RuntimeError('Abseil checksum mismatch')
    sources = work/'source'; sources.mkdir(exist_ok=True)
    absl = sources/'abseil-cpp-20260107.1'
    if not absl.exists():
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                path = (sources/member.name).resolve()
                if sources not in path.parents or member.issym() or member.islnk():
                    raise RuntimeError('Unsafe dependency archive entry')
            tar.extractall(sources)
    shadow = sources/'sentencepiece'
    if not shadow.exists():
        def ignore(directory, names):
            ignored = {'.git'}
            if Path(directory) == sp/'third_party':
                ignored |= {'absl', 'abseil-cpp'}
            return set(names) & ignored
        shutil.copytree(sp, shadow, symlinks=True, ignore=ignore)
        (shadow/'.ainvr-pinned-source').write_text(lock['sentencepiece']['commit']+'\n')
    if (shadow/'.ainvr-pinned-source').read_text().strip() != lock['sentencepiece']['commit']:
        raise RuntimeError('Shadow source identity mismatch')
    prefix = work/'prefix'
    run('cmake', '-S', absl, '-B', work/'build-abseil', '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CXX_STANDARD=17', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
        '-DABSL_PROPAGATE_CXX_STD=ON', '-DABSL_ENABLE_INSTALL=ON', '-DBUILD_TESTING=OFF',
        '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_INSTALL_PREFIX='+str(prefix))
    run('cmake', '--build', work/'build-abseil', '--target', 'install', '-j', args.jobs)
    license_dir = prefix/'share/licenses/ainvr-search-tokenizer'; license_dir.mkdir(parents=True, exist_ok=True)
    for name, path in [('abseil-LICENSE', absl/'LICENSE'), ('sentencepiece-LICENSE', sp/'LICENSE'),
                       ('tokenizers-cpp-LICENSE', source/'LICENSE')]:
        shutil.copyfile(path, license_dir/name)
    project = work/'test-project'; project.mkdir(exist_ok=True)
    cmake = '''cmake_minimum_required(VERSION 3.22)
project(tokenizer_software LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(ICU 70 REQUIRED COMPONENTS uc)
find_package(OpenSSL REQUIRED)
find_package(nlohmann_json REQUIRED)
set(SPM_ABSL_PROVIDER package CACHE STRING "" FORCE)
set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
set(SPM_BUILD_TEST OFF CACHE BOOL "" FORCE)
add_subdirectory("@SHADOW@" sp-build EXCLUDE_FROM_ALL)
add_executable(ainvr_search_tokenizer_test "@ROOT@/shared/cpp/checked_sentencepiece_tokenizer.cpp"
  "@ROOT@/search-service/src/siglip_tokenizer.cpp" "@ROOT@/search-service/tests/siglip_tokenizer_test.cpp")
target_include_directories(ainvr_search_tokenizer_test PRIVATE "@ROOT@/shared/cpp" "@ROOT@/search-service/src")
target_include_directories(ainvr_search_tokenizer_test SYSTEM PRIVATE "@TOKENIZERS@/include"
  "@SHADOW@/src" "@SHADOW@/src/builtin_pb" "@SHADOW@/third_party/protobuf-lite")
target_link_libraries(ainvr_search_tokenizer_test PRIVATE sentencepiece-static ICU::uc OpenSSL::Crypto nlohmann_json::nlohmann_json)
target_compile_options(ainvr_search_tokenizer_test PRIVATE -Wall -Wextra -Werror)
'''
    for key, value in [('ROOT', root), ('SHADOW', shadow), ('TOKENIZERS', source)]:
        cmake = cmake.replace('@'+key+'@', str(value))
    (project/'CMakeLists.txt').write_text(cmake)
    run('cmake', '-S', project, '-B', work/'build-test', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_PREFIX_PATH='+str(prefix))
    run('cmake', '--build', work/'build-test', '--target', 'ainvr_search_tokenizer_test', '-j', args.jobs)
    print(json.dumps(dict(binary=str(work/'build-test/ainvr_search_tokenizer_test'),
                          sentencepiece_shadow=str(shadow), abseil_prefix=str(prefix),
                          licenses=str(license_dir), bpu_loaded=False)))


if __name__ == '__main__':
    main()
