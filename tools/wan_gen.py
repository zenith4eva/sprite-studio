"""Wan 2.2 I2V A14B (GGUF, high+low noise experts, lightx2v 4-step LoRAs) via a local ComfyUI.

Needs ComfyUI with ComfyUI-GGUF and these models in its models folders:
  Wan2.2-I2V-A14B-HighNoise-<quant>.gguf, Wan2.2-I2V-A14B-LowNoise-<quant>.gguf   (unet)
  wan2.2_i2v_lightx2v_4steps_lora_v1_{high,low}_noise.safetensors                  (loras)
  umt5_xxl_fp8_e4m3fn_scaled.safetensors (clip), Wan2.1_VAE.safetensors (vae)

usage: python wan_gen.py --still my_wan_start.png --prompt "..." --out raw_walk --seed 7
         [--comfy http://127.0.0.1:8188] [--comfy-dir path/to/ComfyUI]
"""
import argparse, json, shutil, time, urllib.request
from pathlib import Path
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--still", required=True)
ap.add_argument("--prompt", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--w", type=int, default=512)
ap.add_argument("--h", type=int, default=640)
ap.add_argument("--quant", default="Q8_0")
ap.add_argument("--frames", type=int, default=49)  # 4n+1
ap.add_argument("--steps", type=int, default=4)    # total; half per expert
ap.add_argument("--seed", type=int, default=1)
ap.add_argument("--neg-extra", default="")
ap.add_argument("--comfy", default="http://127.0.0.1:8188", help="ComfyUI server URL")
ap.add_argument("--comfy-dir", default="ComfyUI", help="ComfyUI folder (its input/ and output/ are used)")
a = ap.parse_args()

COMFY = a.comfy.rstrip("/")
comfy_in = Path(a.comfy_dir) / "input"
name = f"wansheet_still_{a.seed}.png"
Image.open(a.still).convert("RGB").resize((a.w, a.h), Image.NEAREST).save(comfy_in / name)
neg = ("blurry, low quality, shadow, ground line, camera movement, zoom, pan, gun, rifle, stick, plank, held object, "
       "weapon, background change, extra limbs, deformed, static, motion blur, text, watermark") + (", " + a.neg_extra if a.neg_extra else "")
half = a.steps // 2
LORA = "wan2.2_i2v_lightx2v_4steps_lora_v1_{}_noise.safetensors"
wf = {
    "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "Wan2.2-I2V-A14B-HighNoise-" + a.quant + ".gguf"}},
    "2": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "Wan2.2-I2V-A14B-LowNoise-" + a.quant + ".gguf"}},
    "3": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": LORA.format("high"), "strength_model": 1.0}},
    "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["2", 0], "lora_name": LORA.format("low"), "strength_model": 1.0}},
    "5": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["3", 0], "shift": 5.0}},
    "6": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["4", 0], "shift": 5.0}},
    "7": {"class_type": "CLIPLoader", "inputs": {"clip_name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "type": "wan"}},
    "8": {"class_type": "VAELoader", "inputs": {"vae_name": "Wan2.1_VAE.safetensors"}},
    "9": {"class_type": "CLIPTextEncode", "inputs": {"text": a.prompt, "clip": ["7", 0]}},
    "10": {"class_type": "CLIPTextEncode", "inputs": {"text": neg, "clip": ["7", 0]}},
    "11": {"class_type": "LoadImage", "inputs": {"image": name}},
    "12": {"class_type": "WanImageToVideo", "inputs": {
        "positive": ["9", 0], "negative": ["10", 0], "vae": ["8", 0], "width": a.w, "height": a.h,
        "length": a.frames, "batch_size": 1, "start_image": ["11", 0]}},
    "13": {"class_type": "KSamplerAdvanced", "inputs": {
        "model": ["5", 0], "add_noise": "enable", "noise_seed": a.seed, "steps": a.steps, "cfg": 1.0,
        "sampler_name": "euler", "scheduler": "simple", "positive": ["12", 0], "negative": ["12", 1],
        "latent_image": ["12", 2], "start_at_step": 0, "end_at_step": half, "return_with_leftover_noise": "enable"}},
    "14": {"class_type": "KSamplerAdvanced", "inputs": {
        "model": ["6", 0], "add_noise": "disable", "noise_seed": 0, "steps": a.steps, "cfg": 1.0,
        "sampler_name": "euler", "scheduler": "simple", "positive": ["12", 0], "negative": ["12", 1],
        "latent_image": ["13", 0], "start_at_step": half, "end_at_step": 10000, "return_with_leftover_noise": "disable"}},
    "15": {"class_type": "VAEDecode", "inputs": {"samples": ["14", 0], "vae": ["8", 0]}},
    "16": {"class_type": "SaveImage", "inputs": {"images": ["15", 0], "filename_prefix": f"wansheet_{a.seed}"}},
}
req = urllib.request.Request(f"{COMFY}/prompt", json.dumps({"prompt": wf}).encode(), {"Content-Type": "application/json"})
try:
    pid = json.load(urllib.request.urlopen(req))["prompt_id"]
except urllib.error.HTTPError as e:
    raise SystemExit(e.read().decode()[:2000])
print("queued", pid, flush=True)
t0 = time.time()
while True:
    h = json.load(urllib.request.urlopen(f"{COMFY}/history/{pid}"))
    if pid in h:
        break
    time.sleep(5)
st = h[pid]["status"]
if st["status_str"] != "success":
    raise SystemExit(json.dumps(st, indent=1)[:3000])
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
imgs = h[pid]["outputs"]["16"]["images"]
for img in imgs:
    shutil.copy((Path(a.comfy_dir) / "output") / img["subfolder"] / img["filename"], out / img["filename"])
print("done in %.0fs, %d frames -> %s" % (time.time() - t0, len(imgs), out))
