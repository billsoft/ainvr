// COCO 80 类名称常量 —— 对应 Python utils/coco.py。
#pragma once

#include <array>
#include <string_view>

namespace ai_service::utils {

inline constexpr std::array<std::string_view, 80> kCocoNames = {
    "person",        "bicycle",      "car",           "motorcycle",   "airplane",
    "bus",           "train",        "truck",         "boat",         "traffic light",
    "fire hydrant",  "stop sign",    "parking meter", "bench",        "bird",
    "cat",           "dog",          "horse",         "sheep",        "cow",
    "elephant",      "bear",         "zebra",         "giraffe",      "backpack",
    "umbrella",      "handbag",      "tie",           "suitcase",     "frisbee",
    "skis",          "snowboard",    "sports ball",   "kite",         "baseball bat",
    "baseball glove","skateboard",   "surfboard",     "tennis racket","bottle",
    "wine glass",    "cup",          "fork",          "knife",        "spoon",
    "bowl",          "banana",       "apple",         "sandwich",     "orange",
    "broccoli",      "carrot",       "hot dog",       "pizza",        "donut",
    "cake",          "chair",        "couch",         "potted plant", "bed",
    "dining table",  "toilet",       "tv",            "laptop",       "mouse",
    "remote",        "keyboard",     "cell phone",    "microwave",    "oven",
    "toaster",       "sink",         "refrigerator",  "book",         "clock",
    "vase",          "scissors",     "teddy bear",    "hair drier",   "toothbrush",
};

static_assert(kCocoNames.size() == 80, "COCO 80 类数量不对");

}  // namespace ai_service::utils
