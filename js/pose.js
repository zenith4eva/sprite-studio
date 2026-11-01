// Skeleton, forward/inverse kinematics and the animation library.
// Character space: +x is the character's left, +y up, +z forward. Units are art pixels.
(function (SS) {
  'use strict';
  const { v3, m3, D2R } = SS;

  SS.restPose = () => ({
    root: [0, 0, 0],          // pelvis offset
    chestShift: [0, 0, 0],    // extra offset of everything above the waist
    pelvis: [0, 0, 0],        // yaw, pitch, roll in degrees (pitch > 0 leans forward)
    spine: [0, 0, 0],         // relative to the pelvis
    head: [0, 0, 0],          // relative to the chest
    breath: 0,                // 0..1: chest and shoulders rise by a fraction of a pixel
    arm: {
      L: { swing: 0, abduct: 4, twist: 0, elbow: 10, wrist: 0 },
      R: { swing: 0, abduct: 4, twist: 0, elbow: 10, wrist: 0 },
    },
    leg: { L: null, R: null }, // null = standing rest; else { x, z, lift, pitch } of the foot
    hair: 0,                  // secondary motion of loose hair (-1..1)
    cock: 22,                 // weapon angle off the forearm line
    flash: false,
    smearFrom: null,          // previous pose: blade copies are swept from it to this one
  });

  const clonePose = (p) => JSON.parse(JSON.stringify(p));
  SS.clonePose = clonePose;

  // linear blend of two poses (smear sampling, holds and in-betweens)
  SS.blendPose = (a, b, t) => {
    const out = clonePose(b);
    const L = (x, y) => x + (y - x) * t;
    const LA = (x, y) => x.map((v, i) => L(v, y[i]));
    out.root = LA(a.root, b.root); out.chestShift = LA(a.chestShift, b.chestShift);
    out.pelvis = LA(a.pelvis, b.pelvis); out.spine = LA(a.spine, b.spine); out.head = LA(a.head, b.head);
    out.breath = L(a.breath, b.breath); out.cock = L(a.cock, b.cock);
    for (const s of ['L', 'R']) for (const k of Object.keys(b.arm[s])) out.arm[s][k] = L(a.arm[s][k], b.arm[s][k]);
    return out;
  };

  // foot description -> ankle position. The foot pitches about its ankle and is lifted so its
  // lowest sole point sits at `lift` above the ground.
  const footFrame = (yawDeg, pitchDeg) => m3.mul(m3.ry(yawDeg * D2R), m3.rx(-pitchDeg * D2R));
  function footToAnkle(P, spec, yawDeg) {
    const R = footFrame(yawDeg, spec.pitch || 0);
    const heel = m3.v(R, [0, -P.ankleY, -P.heelBack + P.footR[0] * 0.6]);
    const toe = m3.v(R, [0, -P.ankleY, P.footLen - P.heelBack - P.footR[1] * 0.6]);
    const minY = Math.min(heel[1], toe[1]);
    return { ankle: [spec.x, (spec.lift || 0) - minY, spec.z], R };
  }

  function ik2(a, c, l1, l2, pole) {
    let d = v3.sub(c, a);
    let dist = v3.len(d) || 1e-6;
    const maxD = l1 + l2 - 0.01;
    if (dist > maxD) { c = v3.add(a, v3.mul(d, maxD / dist)); d = v3.sub(c, a); dist = maxD; }
    dist = Math.max(dist, Math.abs(l1 - l2) + 0.01);
    const dir = v3.norm(d);
    const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    const pp = v3.norm(v3.sub(pole, v3.mul(dir, v3.dot(pole, dir))));
    return { mid: v3.add(v3.add(a, v3.mul(dir, x)), v3.mul(pp, h)), end: c };
  }

  // pose -> joint positions and frames (character space)
  SS.solve = (P, pose) => {
    const J = {};
    const Rp = m3.ypr(pose.pelvis[0], pose.pelvis[1], pose.pelvis[2]);
    const pc = v3.add([0, P.pelvisY, 0], pose.root);
    const Rc = m3.mul(Rp, m3.ypr(pose.spine[0], pose.spine[1], pose.spine[2]));
    const Rm = m3.mul(Rp, m3.ypr(pose.spine[0] * 0.5, pose.spine[1] * 0.5, pose.spine[2] * 0.5));
    const br = pose.breath;
    const waist = v3.add(v3.add(pc, m3.v(Rp, [0, P.waistOff, 0])), pose.chestShift);
    J.Rp = Rp; J.Rc = Rc; J.Rm = Rm;
    J.pelvis = pc; J.waist = waist;
    J.abdomen = v3.add(v3.add(pc, m3.v(Rm, [0, P.waistOff + P.abdomen.off, 0])), v3.mul(pose.chestShift, 0.5));
    J.ribs = v3.add(waist, m3.v(Rc, [0, P.ribs.off + br * 0.45, 0.05 + br * 0.15]));
    J.shoulderBar = v3.add(waist, m3.v(Rc, [0, P.shoulderBar.off + br * 0.55, -0.1]));
    J.neckBase = v3.add(waist, m3.v(Rc, [0, P.neckOff + br * 0.5, 0.1]));
    J.neckTop = v3.add(J.neckBase, m3.v(Rc, [0, P.neckLen, 0.7]));  // the neck leans forward out of the shoulders
    const Rh = m3.mul(Rc, m3.ypr(pose.head[0], pose.head[1], pose.head[2]));
    J.Rh = Rh;
    J.head = v3.add(J.neckTop, m3.v(Rh, [0, P.headUp, P.headFwd]));

    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const a = pose.arm[side];
      const sh = v3.add(waist, m3.v(Rc, [s * P.shoulderX, P.shoulderOff + br * 0.55, 0]));
      const Ru = m3.mul(Rc, m3.mul(m3.rx(-a.swing * D2R), m3.mul(m3.rz(s * a.abduct * D2R), m3.ry(s * a.twist * D2R))));
      const el = v3.add(sh, m3.v(Ru, [0, -P.upperArm, 0]));
      const Rf = m3.mul(Ru, m3.rx(-a.elbow * D2R));
      const wr = v3.add(el, m3.v(Rf, [0, -P.foreArm, 0]));
      const Rw = m3.mul(Rf, m3.rx(-a.wrist * D2R));
      const tip = v3.add(wr, m3.v(Rw, [0, -P.hand, 0]));
      J['shoulder' + side] = sh; J['elbow' + side] = el; J['wrist' + side] = wr; J['hand' + side] = tip;
      J['Ru' + side] = Ru; J['Rf' + side] = Rf; J['Rw' + side] = Rw;

      const hip = v3.add(pc, m3.v(Rp, [s * P.hipX, P.hipJointOff, 0.2]));
      const spec = pose.leg[side] || { x: s * P.ankleX, z: P.ankleZ, lift: 0, pitch: 0 };
      const yaw = pose.pelvis[0] * 0.6 + s * P.splay;
      const f = footToAnkle(P, { x: spec.x ?? s * P.ankleX, z: spec.z ?? P.ankleZ, lift: spec.lift || 0, pitch: spec.pitch || 0 }, yaw);
      const pole = m3.v(Rp, [s * 0.18, 0.05, 1]);
      const r = ik2(hip, f.ankle, P.thigh, P.shin, pole);
      J['hip' + side] = hip; J['knee' + side] = r.mid; J['ankle' + side] = r.end; J['Rfoot' + side] = f.R;
      J['footSpec' + side] = spec;
    }
    return J;
  };

  // how far the pelvis must drop (<= 0) so every planted foot can reach the ground
  SS.reachDrop = (P, pose) => {
    let drop = 0;
    const base = SS.solve(P, pose);
    for (const side of ['L', 'R']) {
      const spec = pose.leg[side];
      if (spec && spec.lift > 0.3) continue;
      const hip = base['hip' + side];
      const s = side === 'L' ? 1 : -1;
      const f = footToAnkle(P, { x: spec ? spec.x : s * P.ankleX, z: spec ? spec.z : P.ankleZ, lift: spec ? spec.lift || 0 : 0, pitch: spec ? spec.pitch || 0 : 0 }, 0);
      const dx = hip[0] - f.ankle[0], dz = hip[2] - f.ankle[2];
      const reach = (P.thigh + P.shin) * 0.997;
      const maxY = f.ankle[1] + Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
      drop = Math.min(drop, maxY - hip[1]);
    }
    return drop;
  };

  // ---------- gait ----------
  // One foot's in-place cycle. Stance slides it back under the body (the conveyor that matches the
  // ground speed); swing carries it forward with toe clearance. u is the foot's phase, 0 = heel strike.
  function footCycle(u, g) {
    u = SS.fract(u);
    if (u < g.beta) {
      const s = u / g.beta;
      let pitch = 0;
      if (s < 0.2) pitch = g.strike * (1 - s / 0.2);
      else if (s > 0.6) pitch = -g.toeOff * Math.pow((s - 0.6) / 0.4, 1.3);
      return { z: g.reach - 2 * g.reach * s, lift: 0, pitch, stance: true };
    }
    const s = (u - g.beta) / (1 - g.beta);
    const e = SS.smoothstep(g.kick || 0, 1, s);
    const lift = g.lift * Math.pow(Math.sin(Math.PI * Math.pow(s, g.liftSkew || 0.8)), 0.9);
    const pitch = SS.lerp(-g.toeOff, g.strike, SS.smoothstep(0.15, 0.9, s));
    return { z: -g.reach + 2 * g.reach * e, lift, pitch, stance: false };
  }

  function legsFromGait(P, ph, g, pose, opt = {}) {
    const fl = footCycle(ph, g), fr = footCycle(ph + 0.5, g);
    const R = opt.right ? footCycle(ph + 0.5, opt.right) : fr;
    pose.leg.L = { x: P.ankleX + (opt.wide || 0), z: fl.z + P.ankleZ, lift: fl.lift, pitch: fl.pitch };
    pose.leg.R = { x: -P.ankleX - (opt.wide || 0), z: R.z + P.ankleZ, lift: R.lift, pitch: R.pitch };
    return { fl, fr: R };
  }

  // keep the whole upper body on whole pixels, so the head and torso never re-rasterise mid-cycle
  function settleRoot(P, pose, artBob) {
    const need = SS.reachDrop(P, pose);
    pose.root[1] = Math.floor(Math.min(need, artBob) + 1e-6);
  }

  const P_ = (key, label, min, max, step, def) => ({ key, label, min, max, step, def });

  // ---------- animation library ----------
  // Each entry: frames n, loop mode, tweakable params, pose(k, n, prm, P, cfg) and ms(k, n, prm).
  SS.ANIMS = {
    idle: {
      label: 'Idle (breathing)', n: 8, loop: 'loop',
      params: [P_('depth', 'Breath depth', 0, 1.5, 0.05, 0.75), P_('ms', 'Base ms', 80, 260, 5, 140)],
      // fast inhale, held peak, slow exhale, held trough: extremes about twice as long as transitions
      curve: [0, 0.4, 0.82, 1, 0.78, 0.52, 0.27, 0.06],
      holds: [1.7, 0.8, 0.8, 1.8, 1, 1, 1, 1.3],
      pose(k, n, p, P, cfg) {
        const pose = SS.restPose();
        const c = sample(this.curve, k, n), lag = sample(this.curve, k - 2, n);
        pose.breath = c * p.depth;
        pose.arm.L.abduct = pose.arm.R.abduct = 4 + c * 1.0;
        pose.arm.L.swing = pose.arm.R.swing = -1 + c * 1;
        pose.hair = (lag - 0.5) * 0.9;
        idleExtras(pose, cfg);
        return pose;
      },
      ms(k, n, p) { return Math.round(p.ms * sample(this.holds, k, n)); },
    },
    walk: {
      label: 'Walk', n: 8, loop: 'loop',
      params: [P_('stride', 'Stride (px)', 6, 18, 0.5, 11.5), P_('bob', 'Bob (px)', 0, 2, 1, 1), P_('swing', 'Arm swing (deg)', 0, 50, 1, 20),
        P_('sway', 'Hip shift (px)', 0, 1.5, 0.1, 0.6), P_('ms', 'ms / frame', 50, 180, 5, 100)],
      pose(k, n, p, P, cfg) {
        const ph = k / n, pose = SS.restPose();
        const g = { beta: 0.6, reach: p.stride * 0.6, lift: 2.6, strike: 14, toeOff: 26, liftSkew: 0.75 };
        legsFromGait(P, ph, g, pose);
        const half = SS.fract(ph * 2);
        // lowest at contact and the recoil after it, back up by the pass
        const art = -p.bob * (half < 0.3 ? 1 : 0);
        const c = Math.cos(2 * Math.PI * (ph - 0.04));
        pose.pelvis = [-5 * c, 2, 1.6 * Math.sin(2 * Math.PI * ph)];
        pose.spine = [8 * c, 3, -1.6 * Math.sin(2 * Math.PI * ph)];
        pose.head = [-(pose.pelvis[0] + pose.spine[0]), -5, 0];
        const sway = Math.round(p.sway * Math.sin(2 * Math.PI * (ph + 0.12)));
        pose.root[0] = sway; pose.chestShift[0] = -sway;
        armSwing(pose, ph, p.swing, 14, 7);
        settleRoot(P, pose, art);
        pose.hair = Math.sin(2 * Math.PI * (ph * 2 - 0.3)) * 0.6;
        holdWeapon(pose, cfg);
        return pose;
      },
      ms(k, n, p) { return p.ms; },
    },
    run: {
      label: 'Run', n: 8, loop: 'loop',
      params: [P_('stride', 'Stride (px)', 10, 26, 0.5, 19), P_('lean', 'Lean (deg)', 0, 20, 1, 12), P_('swing', 'Arm pump (deg)', 10, 60, 1, 36),
        P_('bob', 'Bob (px)', 0, 3, 1, 2), P_('ms', 'ms / frame', 40, 120, 5, 70)],
      pose(k, n, p, P, cfg) {
        const ph = k / n, pose = SS.restPose();
        const g = { beta: 0.36, reach: p.stride * 0.42, lift: 6.5, strike: 8, toeOff: 42, kick: 0.22, liftSkew: 0.6 };
        const { fl, fr } = legsFromGait(P, ph, g, pose);
        const c = Math.cos(2 * Math.PI * (ph - 0.03));
        pose.pelvis = [-8 * c, p.lean * 0.35, 0];
        pose.spine = [13 * c, p.lean, 0];
        pose.head = [-(pose.pelvis[0] + pose.spine[0]), -p.lean * 1.15, 0];
        // triangle bob: sinks over the stance, springs up into the flight
        const flight = !fl.stance && !fr.stance;
        const half = SS.fract(ph * 2);
        const art = flight ? 0 : -p.bob * SS.tri(half / 0.72, 0.5);
        for (const [side, s] of [['L', 1], ['R', -1]]) {
          const ua = SS.fract(ph + (side === 'L' ? 0 : 0.5) - 0.04);
          const sw = -Math.cos(2 * Math.PI * ua);
          pose.arm[side] = { swing: p.swing * 1.15 * sw - 10, abduct: 9, twist: s * 6, elbow: 88 + 10 * sw, wrist: 10 };
        }
        settleRoot(P, pose, art);
        if (flight) pose.root[1] = Math.max(pose.root[1], 0);
        pose.hair = Math.sin(2 * Math.PI * (ph * 2 - 0.35)) * 1;
        holdWeapon(pose, cfg, true);
        return pose;
      },
      ms(k, n, p) { return p.ms; },
    },
    attack: {
      label: 'Attack (light swing)', n: 6, loop: 'once', fixed: true,
      params: [P_('reach', 'Lunge (px)', 0, 4, 0.5, 2), P_('speed', 'Speed', 0.5, 2, 0.05, 1)],
      ms(k, n, p) { return Math.round([100, 50, 50, 50, 110, 60][k] / p.speed); },
      pose(k, n, p, P, cfg) { return attackPose(k, p, P, cfg); },
    },
    hurt: {
      label: 'Hurt', n: 3, loop: 'once', fixed: true,
      params: [P_('knock', 'Knockback (px)', 0, 4, 0.5, 2)],
      ms(k) { return [55, 85, 140][k]; },
      pose(k, n, p, P, cfg) {
        const pose = SS.restPose();
        idleExtras(pose, cfg);
        if (k === 0) { pose.flash = true; return pose; }
        const t = k === 1 ? 1 : 0.45;
        pose.root[2] = -Math.round(p.knock * t);
        pose.spine = [0, -13 * t, 0]; pose.pelvis = [0, -4 * t, 0];
        pose.head = [0, -12 * t, 0];
        pose.arm.L = { swing: 22 * t, abduct: 7 + 26 * t, twist: 0, elbow: 12 + 30 * t, wrist: 0 };
        pose.arm.R = { swing: 18 * t, abduct: 7 + 22 * t, twist: 0, elbow: 12 + 34 * t, wrist: 0 };
        settleRoot(P, pose, 0);
        holdWeapon(pose, cfg);
        return pose;
      },
    },
    death: {
      label: 'Death (collapse)', n: 7, loop: 'hold', fixed: true,
      params: [],
      ms(k) { return [90, 80, 120, 100, 80, 130, 520][k]; },
      pose(k, n, p, P, cfg) { return deathPose(k, P, cfg); },
    },
    pant: {
      label: 'Winded (pant)', n: 8, loop: 'loop',
      params: [P_('hunch', 'Hunch (deg)', 0, 40, 1, 24), P_('ms', 'Base ms', 70, 200, 5, 120)],
      // fast inhale, slow exhale: reads as exhausted
      curve: [0, 0.65, 1, 0.82, 0.6, 0.4, 0.22, 0.08],
      holds: [1.3, 0.8, 1.6, 1.1, 1.1, 1.1, 1.1, 1.3],
      pose(k, n, p, P, cfg) {
        const pose = SS.restPose();
        const c = sample(this.curve, k, n);
        pose.pelvis = [0, p.hunch * 0.55, 0];
        pose.spine = [0, p.hunch * 0.75 - c * 4, 0];
        pose.head = [0, -p.hunch * 0.9 + c * 3, 0];
        pose.breath = c * 1.1;
        pose.leg.L = { x: P.ankleX + 0.8, z: P.ankleZ + 0.6, lift: 0, pitch: 0 };
        pose.leg.R = { x: -P.ankleX - 0.8, z: P.ankleZ - 0.4, lift: 0, pitch: 0 };
        for (const [side, s] of [['L', 1], ['R', -1]])
          pose.arm[side] = { swing: 26 + p.hunch * 0.5 - c * 3, abduct: 13, twist: s * 4, elbow: 6, wrist: 4 };
        settleRoot(P, pose, -Math.round(p.hunch / 9));
        pose.hair = (sample(this.curve, k - 1, n) - 0.5) * 0.8;
        holdWeapon(pose, cfg);
        return pose;
      },
      ms(k, n, p) { return Math.round(p.ms * sample(this.holds, k, n)); },
    },
    shamble: {
      label: 'Shamble (zombie walk)', n: 8, loop: 'loop',
      params: [P_('stride', 'Stride (px)', 4, 14, 0.5, 8), P_('drag', 'Leg drag', 0, 1, 0.05, 0.75), P_('reachArms', 'Arms forward (deg)', 0, 100, 1, 78)],
      holds: [1.35, 0.95, 0.95, 1.5, 1.25, 0.9, 0.9, 1.3],
      ms(k, n) { return Math.round(115 * sample(this.holds, k, n)); },
      pose(k, n, p, P, cfg) {
        const ph = k / n, pose = SS.restPose();
        const gl = { beta: 0.6, reach: p.stride * 0.55, lift: 2.2, strike: 10, toeOff: 18, liftSkew: 0.8 };
        const gr = { beta: 0.66, reach: p.stride * 0.5, lift: 2.2 * (1 - p.drag) + 0.25, strike: 2, toeOff: 12 * (1 - p.drag) + 6, liftSkew: 1 };
        const { fr } = legsFromGait(P, ph, gl, pose, { right: gr });
        const sway = Math.sin(2 * Math.PI * ph);
        pose.pelvis = [-4 * Math.cos(2 * Math.PI * ph), 5, 3 * sway];
        pose.spine = [6 * Math.cos(2 * Math.PI * ph), 13, -6 * sway];
        pose.head = [-4, 6, 13 + 1 * sway];
        for (const [side, s] of [['L', 1], ['R', -1]]) {
          const o = Math.sin(2 * Math.PI * (ph + (side === 'L' ? 0.1 : 0.6)));
          pose.arm[side] = { swing: p.reachArms + 6 * o - (side === 'R' ? 6 : 0), abduct: 11, twist: -s * 6, elbow: 16 + 6 * o, wrist: -6 };
        }
        // the dragged leg's stance sinks the body a pixel further: a limp
        const limp = fr.stance && SS.fract(ph + 0.5) < 0.4 ? -1 : 0;
        settleRoot(P, pose, limp);
        pose.hair = Math.sin(2 * Math.PI * (ph - 0.25)) * 0.8;
        return pose;
      },
    },
  };
  SS.ANIM_ORDER = ['idle', 'walk', 'run', 'attack', 'hurt', 'death', 'pant', 'shamble'];

  function sample(arr, k, n) {
    // resample a curve authored for 8 frames to n frames (wrapping)
    const t = SS.fract(k / n) * arr.length;
    const i = Math.floor(t), f = t - i;
    return SS.lerp(arr[i % arr.length], arr[(i + 1) % arr.length], f);
  }

  function armSwing(pose, ph, amp, elbowBase, elbowFwd) {
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      // arms swing against the legs and lag them a little
      const ua = SS.fract(ph + (side === 'L' ? 0 : 0.5) - 0.06);
      const sw = -Math.cos(2 * Math.PI * ua);
      pose.arm[side] = { swing: amp * sw, abduct: 5, twist: 0, elbow: elbowBase + elbowFwd * Math.max(0, sw), wrist: 0 };
    }
  }

  function idleExtras(pose, cfg) {
    if (cfg && cfg.zombie && cfg.zombie.on) {
      pose.spine[1] += 9; pose.pelvis[1] += 3; pose.head = [-3, 8, 12];
      pose.arm.L.swing += 12; pose.arm.R.swing += 8; pose.arm.L.elbow += 10;
    }
    holdWeapon(pose, cfg);
  }

  function holdWeapon(pose, cfg, running) {
    if (!cfg || cfg.weapon.type === 'none') return;
    // the weapon hand carries the blade forward and slightly out so it clears the leg
    const a = pose.arm.R;
    a.elbow = Math.max(a.elbow, running ? a.elbow : 24);
    a.abduct = Math.max(a.abduct, 10);
    pose.cock = running ? 55 : 70;
  }

  function attackPose(k, p, P, cfg) {
    const keys = [
      // anticipation: wind up over the shoulder, torso turned back, weight on the back foot
      { spine: [-30, -5, 0], pelvis: [-12, 0, 0], R: [168, 24, 0, 78, 12], L: [34, 20, 0, 36, 0], z: 0, cock: 30 },
      // smear frames bridge the wind-up to full extension
      { spine: [-8, 2, 0], pelvis: [-4, 1, 0], R: [112, 18, 0, 34, 4], L: [20, 18, 0, 30, 0], z: 0.5, cock: 20, smear: true },
      { spine: [14, 8, 0], pelvis: [4, 3, 0], R: [52, 10, -6, 14, 0], L: [-4, 16, 0, 26, 0], z: 1, cock: 14, smear: true },
      { spine: [26, 12, 0], pelvis: [9, 4, 0], R: [6, -6, -16, 8, 0], L: [-20, 14, 0, 24, 0], z: 1, cock: 10, smear: true },
      // follow-through: full extension plus one pixel of overshoot, held
      { spine: [32, 14, 0], pelvis: [11, 5, 0], R: [-20, -16, -24, 6, 0], L: [-26, 14, 0, 22, 0], z: 2, cock: 8 },
      // recover toward idle
      { spine: [12, 5, 0], pelvis: [4, 2, 0], R: [14, 2, -6, 20, 0], L: [0, 10, 0, 16, 0], z: 1, cock: 30 },
    ];
    const build = (i) => {
      const kf = keys[i], pose = SS.restPose();
      pose.spine = kf.spine.slice(); pose.pelvis = kf.pelvis.slice();
      pose.head = [-(kf.spine[0] + kf.pelvis[0]) * 0.75, -(kf.spine[1] + kf.pelvis[1]) * 0.8, 0];
      const arm = (v) => ({ swing: v[0], abduct: v[1], twist: v[2], elbow: v[3], wrist: v[4] });
      pose.arm.R = arm(kf.R); pose.arm.L = arm(kf.L);
      pose.cock = kf.cock;
      pose.root[2] = Math.round(kf.z * p.reach / 2);
      pose.leg.L = { x: P.ankleX + 0.5, z: P.ankleZ + 4.5, lift: 0, pitch: 0 };
      pose.leg.R = { x: -P.ankleX - 0.5, z: P.ankleZ - 4.5, lift: 0, pitch: -4 };
      settleRoot(P, pose, i >= 2 && i <= 4 ? -1 : 0);
      pose.hair = [0.6, -0.4, -0.9, -0.6, 0.3, 0.5][i];
      return pose;
    };
    const pose = build(k);
    if (keys[k].smear) pose.smearFrom = build(k - 1);
    if (!cfg || cfg.weapon.type === 'none') pose.cock = 0;
    return pose;
  }

  function deathPose(k, P) {
    const pose = SS.restPose();
    const lieY = 3.4 - P.pelvisY;
    const keys = [
      { root: [0, 0, -1], pelvis: [0, -5, 0], spine: [0, -10, 0], head: [0, -10, 0], L: [16, 26, 0, 26], R: [12, 24, 0, 30], feet: 0 },
      { root: [0, -5, 0], pelvis: [0, 4, 0], spine: [0, 6, 0], head: [0, 12, 0], L: [-8, 16, 0, 20], R: [-6, 18, 0, 24], feet: 0 },
      { root: [0, -11, 1], pelvis: [0, 10, 0], spine: [0, 14, 0], head: [0, 18, 0], L: [-4, 14, 0, 16], R: [-4, 14, 0, 18], feet: 1 },
      { root: [0, -14, 0], pelvis: [0, 24, 0], spine: [0, 32, 0], head: [0, 22, 0], L: [28, 16, 0, 22], R: [24, 16, 0, 20], feet: 1 },
      { root: [0, -19, -1], pelvis: [0, 54, 0], spine: [0, 26, 0], head: [0, 10, 0], L: [80, 24, 0, 30], R: [74, 26, 0, 26], feet: 2 },
      { root: [0, lieY, -3], pelvis: [0, 86, 0], spine: [0, 4, 3], head: [-26, -6, 0], L: [160, 30, 0, 18], R: [150, 34, 0, 22], feet: 3 },
      { root: [0, lieY - 0.35, -3], pelvis: [0, 86, 0], spine: [0, 3, 3], head: [-26, -5, 0], L: [160, 31, 0, 18], R: [150, 35, 0, 22], feet: 3 },
    ];
    const kf = keys[k];
    pose.root = kf.root.slice(); pose.pelvis = kf.pelvis.slice(); pose.spine = kf.spine.slice(); pose.head = kf.head.slice();
    const arm = (v) => ({ swing: v[0], abduct: v[1], twist: v[2], elbow: v[3], wrist: 0 });
    pose.arm.L = arm(kf.L); pose.arm.R = arm(kf.R);
    // feet: planted, then the toes take the weight as the knees reach the ground, then the legs lie back
    const feet = [
      [{ z: 0, pitch: 0 }, { z: 0, pitch: 0 }],
      [{ z: -2.5, pitch: -38 }, { z: -2, pitch: -34 }],
      [{ z: -9, pitch: -70 }, { z: -8.5, pitch: -66 }],
      [{ z: -25, pitch: -86, lift: 0.5 }, { z: -24.5, pitch: -84, lift: 0.5 }],
    ][kf.feet];
    pose.leg.L = { x: P.ankleX + 0.5, z: P.ankleZ + feet[0].z, lift: feet[0].lift || 0, pitch: feet[0].pitch };
    pose.leg.R = { x: -P.ankleX - 0.5, z: P.ankleZ + feet[1].z, lift: feet[1].lift || 0, pitch: feet[1].pitch };
    pose.hair = [0.4, -0.8, -0.4, 0.6, 1, -0.3, -0.2][k];
    return pose;
  }

  // resolve an animation into frames: [{ pose, ms }]
  SS.animFrames = (name, cfg, P, prm, nOverride) => {
    const A = SS.ANIMS[name];
    const p = {};
    for (const d of A.params) p[d.key] = prm && prm[d.key] != null ? prm[d.key] : d.def;
    const n = A.fixed ? A.n : nOverride || A.n;
    const out = [];
    for (let k = 0; k < n; k++) out.push({ pose: A.pose(k, n, p, P, cfg), ms: A.ms(k, n, p) });
    return { frames: out, loop: A.loop };
  };
})(window.SS);
