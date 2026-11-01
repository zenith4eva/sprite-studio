"""In-betweens for a Wan clip, made on the raw video frames before pixel snapping.

For each pair of frames, DIS optical flow runs both ways. Each frame is warped to time t, and the
two warps are averaged where they agree. Where they disagree (a fast forearm the flow could not
follow) averaging gives a ghosted double arm, so each disagreeing region takes one warp whole:
the one whose flow is more forward-backward consistent there. The result is a real intermediate pose; the snap step then turns it back
into clean pixels on the anchor palette. A crossfade of two snapped frames would only make ghosts.

usage: python interp.py raw_run raw_run_x2 --n 1     (pip install opencv-python numpy)
"""
import argparse
from pathlib import Path

import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("out")
ap.add_argument("--n", type=int, default=1, help="in-betweens per pair (1 doubles the frame rate)")
ap.add_argument("--agree", type=float, default=40, help="colour distance above which the two warps disagree")
ap.add_argument("--blend", action="store_true", help="old behaviour: always average the two warps")
a = ap.parse_args()

files = sorted(Path(a.src).glob("*.png"))
frames = [cv2.imread(str(f), cv2.IMREAD_COLOR) for f in files]
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
H, W = frames[0].shape[:2]
gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))


def warp(img, flow, t):
    # backward warp: the pixel at x at time t came from x - t * flow(x)
    return cv2.remap(img, gx - t * flow[..., 0], gy - t * flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def remap_flow(g, f):
    # the flow g looked up where f lands: g(x + f(x))
    return cv2.remap(g, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


k = 0
for i, f in enumerate(frames):
    cv2.imwrite(str(out / f"f_{k:05d}.png"), f)
    k += 1
    if i == len(frames) - 1:
        break
    g0, g1 = (cv2.cvtColor(x, cv2.COLOR_BGR2GRAY) for x in (f, frames[i + 1]))
    f01, f10 = dis.calc(g0, g1, None), dis.calc(g1, g0, None)
    for j in range(1, a.n + 1):
        t = j / (a.n + 1)
        w0, w1 = warp(f, f01, t).astype(np.float32), warp(frames[i + 1], f10, 1 - t).astype(np.float32)
        m = (1 - t) * w0 + t * w1
        if not a.blend:
            # forward-backward error of each warp, sampled at time t
            e0 = warp(np.linalg.norm(f01 + remap_flow(f10, f01), axis=2), f01, t)
            e1 = warp(np.linalg.norm(f10 + remap_flow(f01, f10), axis=2), f10, 1 - t)
            bad = (np.linalg.norm(w0 - w1, axis=2) > a.agree).astype(np.uint8)
            bad = cv2.dilate(bad, np.ones((5, 5), np.uint8))
            nl, lab = cv2.connectedComponents(bad)
            for c in range(1, nl):
                r = lab == c
                pick = w0 if e0[r].mean() + 2 * t <= e1[r].mean() + 2 * (1 - t) else w1
                m[r] = pick[r]
        cv2.imwrite(str(out / f"f_{k:05d}.png"), np.clip(m, 0, 255).astype(np.uint8))
        k += 1
print(f"{len(frames)} -> {k} frames in {out}")
