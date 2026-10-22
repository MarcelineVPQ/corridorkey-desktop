// ck-trt-build: builds one network's TensorRT engine, strongly typed, for corridorkey-engine's opt-in TensorRT
// path (docs/ENGINE_RUST.md "TensorRT").
//
// Why a separate program: ONNX Runtime's TensorRT provider builds weakly typed networks, where TensorRT picks
// FP16 kernels whose error on these networks is 2-4x ONNX Runtime's CUDA FP16 (measured per network). A
// strongly typed network follows the ONNX file's types exactly, so the TensorRT-ready exports keep their
// weight GEMMs and convolutions in FP32 islands (to_trt.py --fp32-ops) and the rest in FP16, which matches the
// CUDA FP16 parity. ONNX Runtime then runs the engine through an EPContext model. Building in a child process
// also gives the builder's host memory back as soon as the build ends.
//
// usage: ck-trt-build --onnx FILE.onnx --engine OUT.engine --min SHAPES --opt SHAPES --max SHAPES
//                     [--workspace-mb N] [--timing-cache FILE] [--level 0-5] [--weak-fp16]
// SHAPES: ONNX Runtime's TensorRT format, "rgb:1x3x288x480,state:1x541x384".
// Prints one line: {"ok":true,"seconds":12.3,"bytes":123} or {"ok":false,"error":"..."}; exit 0 / 1.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "NvInfer.h"
#include "NvOnnxParser.h"

namespace {

class Logger : public nvinfer1::ILogger {
  public:
    void log(Severity s, const char* msg) noexcept override {
        if (s <= Severity::kERROR) {
            last = msg;
            std::fprintf(stderr, "[TensorRT] %s\n", msg);
        } else if (s == Severity::kWARNING) {
            std::fprintf(stderr, "[TensorRT warning] %s\n", msg);
        }
    }
    std::string last;
};

std::string json_escape(const std::string& s) {
    std::string o;
    // loop: NOT-WORTH — one short message
    for (char c : s) {
        if (c == '"' || c == '\\') {
            o += '\\';
            o += c;
        } else if (static_cast<unsigned char>(c) < 0x20) {
            o += ' ';
        } else {
            o += c;
        }
    }
    return o;
}

int fail(const std::string& why) {
    std::printf("{\"ok\":false,\"error\":\"%s\"}\n", json_escape(why).c_str());
    return 1;
}

// "a:1x2x3,b:4x5" -> {a: [1,2,3], b: [4,5]}
bool parse_shapes(const std::string& s, std::map<std::string, nvinfer1::Dims>& out) {
    std::stringstream ss(s);
    std::string part;
    // loop: NOT-WORTH — at most six inputs
    while (std::getline(ss, part, ',')) {
        auto colon = part.rfind(':');
        if (colon == std::string::npos) return false;
        nvinfer1::Dims d{};
        std::stringstream ds(part.substr(colon + 1));
        std::string v;
        // loop: NOT-WORTH — at most 8 dims
        while (std::getline(ds, v, 'x')) {
            if (d.nbDims >= nvinfer1::Dims::MAX_DIMS) return false;
            d.d[d.nbDims++] = std::stoll(v);
        }
        out[part.substr(0, colon)] = d;
    }
    return !out.empty();
}

}  // namespace

int run(int argc, char** argv) {
    std::map<std::string, std::string> a;
    bool weak = false;
    // loop: NOT-WORTH — the command line
    for (int i = 1; i < argc; i++) {
        std::string k = argv[i];
        if (k == "--weak-fp16") {
            weak = true;
        } else if (k.rfind("--", 0) == 0 && i + 1 < argc) {
            a[k.substr(2)] = argv[++i];
        } else {
            return fail("unknown argument " + k);
        }
    }
    // loop: NOT-WORTH — five required options
    for (const char* k : {"onnx", "engine", "min", "opt", "max"}) {
        if (!a.count(k)) return fail(std::string("missing --") + k);
    }
    std::map<std::string, nvinfer1::Dims> mn, op, mx;
    if (!parse_shapes(a["min"], mn) || !parse_shapes(a["opt"], op) || !parse_shapes(a["max"], mx)) return fail("bad shapes");

    auto t0 = std::chrono::steady_clock::now();
    Logger log;
    std::unique_ptr<nvinfer1::IBuilder> builder(nvinfer1::createInferBuilder(log));
    if (!builder) return fail("TensorRT builder: " + log.last);
    uint32_t flags = weak ? 0U : (1U << static_cast<uint32_t>(nvinfer1::NetworkDefinitionCreationFlag::kSTRONGLY_TYPED));
    std::unique_ptr<nvinfer1::INetworkDefinition> net(builder->createNetworkV2(flags));
    std::unique_ptr<nvonnxparser::IParser> parser(nvonnxparser::createParser(*net, log));
    if (!parser->parseFromFile(a["onnx"].c_str(), static_cast<int>(nvinfer1::ILogger::Severity::kWARNING))) {
        std::string why = parser->getNbErrors() > 0 ? parser->getError(0)->desc() : log.last;
        return fail("parse: " + why);
    }
    std::unique_ptr<nvinfer1::IBuilderConfig> cfg(builder->createBuilderConfig());
    size_t ws = a.count("workspace-mb") ? std::stoull(a["workspace-mb"]) << 20 : size_t(4) << 30;
    cfg->setMemoryPoolLimit(nvinfer1::MemoryPoolType::kWORKSPACE, ws);
    if (a.count("level")) cfg->setBuilderOptimizationLevel(std::stoi(a["level"]));
    if (weak) cfg->setFlag(nvinfer1::BuilderFlag::kFP16);
    nvinfer1::IOptimizationProfile* prof = builder->createOptimizationProfile();
    // loop: NOT-WORTH — the network's inputs
    for (int i = 0; i < net->getNbInputs(); i++) {
        const char* name = net->getInput(i)->getName();
        if (!mn.count(name) || !op.count(name) || !mx.count(name)) return fail(std::string("no shape range for input ") + name);
        prof->setDimensions(name, nvinfer1::OptProfileSelector::kMIN, mn[name]);
        prof->setDimensions(name, nvinfer1::OptProfileSelector::kOPT, op[name]);
        prof->setDimensions(name, nvinfer1::OptProfileSelector::kMAX, mx[name]);
    }
    cfg->addOptimizationProfile(prof);
    // a timing cache shared by the networks of one card speeds up later builds
    std::unique_ptr<nvinfer1::ITimingCache> tc;
    if (a.count("timing-cache")) {
        std::ifstream f(a["timing-cache"], std::ios::binary);
        std::vector<char> blob((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        tc.reset(cfg->createTimingCache(blob.data(), blob.size()));
        if (tc) cfg->setTimingCache(*tc, false);
    }
    std::unique_ptr<nvinfer1::IHostMemory> plan(builder->buildSerializedNetwork(*net, *cfg));
    if (!plan || plan->size() == 0) return fail("build: " + log.last);
    if (tc && a.count("timing-cache")) {
        std::unique_ptr<nvinfer1::IHostMemory> t(cfg->getTimingCache()->serialize());
        std::string tmp = a["timing-cache"] + ".tmp";
        std::ofstream(tmp, std::ios::binary).write(static_cast<const char*>(t->data()), t->size());
        std::rename(tmp.c_str(), a["timing-cache"].c_str());
    }
    std::string tmp = a["engine"] + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary);
        f.write(static_cast<const char*>(plan->data()), plan->size());
        if (!f) return fail("write " + tmp);
    }
    if (std::rename(tmp.c_str(), a["engine"].c_str()) != 0) return fail("rename to " + a["engine"]);
    double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::printf("{\"ok\":true,\"seconds\":%.1f,\"bytes\":%zu}\n", secs, plan->size());
    return 0;
}

// Every failure is the one JSON line: a bad number (std::stoll and friends throw) used to end in std::terminate,
// an abort and a core dump with no answer for the engine (measured: --min "a:1xZ" -> exit 134).
int main(int argc, char** argv) {
    try {
        return run(argc, argv);
    } catch (const std::exception& e) {
        return fail(std::string("bad argument: ") + e.what());
    }
}
