// Character + pose -> a list of 3D primitives (ellipsoids and elliptic round cones) with materials,
// plus decals (eyes, buttons, buckles) that are stamped after shading. All in character space;
// SS.toCamera rotates them for a view.
(function (SS) {
  'use strict';
  const { v3, m3, D2R } = SS;

  const ell = (c, R, r, mat, obj, extra) => Object.assign({ type: 0, c, R, r, mat, obj }, extra);
  const cone = (a, b, ra, rb, mat, obj, extra) => Object.assign({ type: 1, a, b, ra, rb, mat, obj, sx: 1, sz: 1 }, extra);

  // the surface z of an axis-aligned ellipsoid at (x, y), so decals and straps sit on the body
  const surfZ = (r, x, y) => r[2] * Math.sqrt(Math.max(0, 1 - (x / r[0]) ** 2 - (y / r[1]) ** 2));

  SS.buildCharacter = (cfg, P, M, J, pose) => {
    const mi = M.index;
    const prims = [], decals = [];
    const Z = cfg.zombie.on ? cfg.zombie : null;
    const top = cfg.top.type, bot = cfg.bottom.type, hat = cfg.hat.type;
    const sleeveUpper = { none: 0, tank: 0, tshirt: 0.46, buttonshirt: 0.86, longsleeve: 1, hoodie: 1, jacket: 1 }[top];
    const sleeveFore = { longsleeve: 1, hoodie: 1, jacket: 1 }[top] || 0;
    const hem = { none: -1.4, tank: -1.4, tshirt: -3.0, buttonshirt: -1.5, longsleeve: -1.5, hoodie: -3.7, jacket: -4.2 }[top];
    const coverHead = hat === 'cap' || hat === 'beanie' || hat === 'hood' || hat === 'strawhat';
    const add = (p) => { prims.push(p); return p; };
    const inC = (o, R, v) => v3.add(o, m3.v(R, v));

    // torn cloth and blood live on coarse surface cells, so they stick to the cloth from frame to frame
    const zomb = (mat, a, b, c) => {
      if (!Z || (mat !== mi.top && mat !== mi.bottom && mat !== mi.topAcc && mat !== mi.under)) return mat;
      const h = SS.hash3(a, b, c);
      if (h < Z.torn * 0.35) return h < Z.torn * 0.08 ? mi.wound : mi.skin;
      if (h > 1 - Z.blood * 0.22) return mi.blood;
      return mat;
    };

    // ---------- trunk ----------
    // every torso piece reads its material in one frame: the chest frame at the waist pivot
    const tframe = { o: J.waist, R: J.Rc };
    const torsoMat = (lp) => {
      const x = lp[0], y = lp[1], z = lp[2], ax = Math.abs(x);
      let m;
      if (y < hem) {
        m = mi.bottom;
        if (cfg.extras.belt && y > -2.7 && y < -1.4 && bot !== 'skirt') m = mi.belt;
        if (top === 'jacket' && !(z > 0 && ax < 1.9)) m = mi.top;
      } else {
        m = top === 'none' ? mi.skin : mi.top;
        const neckY = P.neckOff;
        if (top === 'buttonshirt' || top === 'jacket') {
          if (z > 0 && y > neckY - 3.3 + ax * 1.4) m = mi.under;
          else if (top === 'buttonshirt' && z > 0 && ax < 0.42) m = mi.topAcc;
          if (top === 'jacket' && z > 0 && ax < 1.7 + Math.max(0, y - 7) * 0.45) m = mi.under;
        } else if (top === 'tshirt' || top === 'longsleeve' || top === 'hoodie') {
          if (z > 0.5 && y > neckY - 2.1 && ax < 2.4) m = mi.topAcc;
          if (top === 'hoodie') {
            if (y < hem + 1.05) m = mi.topAcc;
            else if (z > 1.2 && y > -1.2 && y < 3.4 && ax < 3.6 && (ax > 3.0 || y > 2.6)) m = mi.topAcc;
          }
        } else if (top === 'tank') {
          if (y > 7.5 && ax > 3.2 - (y - 7.5) * 0.15) m = mi.skin;
          if (z > 0.3 && y > neckY - 3.4 + ax * 0.2 && ax < 3.2) m = mi.skin;
        }
        if (bot === 'overalls') {
          if (z > 0 && ax < 3.3 && y < 7.4) m = mi.bottom;
          else if (z < 0 && ax < 3.3 && y < 5) m = mi.bottom;
          else if (ax > 2.0 && ax < 3.3) m = mi.bottom;
        }
      }
      return zomb(m, Math.floor(x / 2.1) + 50, Math.floor(y / 2.1) + 50, z > 0 ? 1 : 2);
    };
    const tm = { mframe: tframe, matFn: torsoMat };
    add(ell(J.pelvis, J.Rp, P.pelvisR.slice(), 0, 'torso', tm));
    add(ell(J.abdomen, J.Rm, P.abdomen.r.slice(), 0, 'torso', tm));
    const ribsR = P.ribs.r.slice();
    ribsR[2] += pose.breath * 0.18;
    add(ell(J.ribs, J.Rc, ribsR, 0, 'torso', tm));
    if (P.chest) for (const s of [1, -1]) add(ell(inC(J.waist, J.Rc, [s * 2.1, P.ribs.off + 0.6, 2.2]), J.Rc, [2.1, 1.9, 1.7], 0, 'torso', tm));
    // anatomical masses (figure-drawing canon): pectorals ride the front of the ribcage, the glutes sit a quarter
    // head behind the pelvis, so the side view gets its chest-forward, seat-back S curve instead of a plank
    else for (const s of [1, -1]) add(ell(inC(J.waist, J.Rc, [s * 2.2, P.ribs.off + 1.5, P.ribs.r[2] * 0.5]), J.Rc, [2.4, 1.8, 1.7], 0, 'torso', tm));
    for (const s of [1, -1]) add(ell(inC(J.pelvis, J.Rp, [s * 1.9, -0.9, -P.pelvisR[2] * 0.62]), J.Rp, [2.5, 2.7, 2.1], 0, 'torso', tm));
    // shoulders slope from the neck down to the arms (trapezius), never square pads
    for (const s of [1, -1]) {
      add(cone(inC(J.waist, J.Rc, [s * 0.8, P.shoulderBar.off + 1.2, -0.4]), inC(J.waist, J.Rc, [s * P.shoulderBar.x, P.shoulderBar.off - 0.6, -0.2]),
        P.shoulderBar.r, P.shoulderBar.r * 0.92, 0, 'torso', Object.assign({ sz: 1.45, zHint: m3.col(J.Rc, 2) }, tm)));
    }
    // a loose shirt hangs straight from the chest to its hem instead of following the waist
    if (top === 'buttonshirt' || top === 'tshirt' || top === 'longsleeve' || top === 'tank') {
      const a = inC(J.waist, J.Rc, [0, P.ribs.off - 0.5, 0.1]), b = inC(J.waist, J.Rc, [0, hem, 0.15]);
      const cut = v3.dist(a, b);
      add(cone(a, b, P.ribs.r[0] - 0.15, P.abdomen.r[0] + 0.35, 0, 'torso', Object.assign({ sz: (P.ribs.r[2] + 0.1) / P.ribs.r[0], zHint: m3.col(J.Rc, 2), clip: (lp) => lp[1] <= cut }, tm)));
    }
    // clothing bulk
    if (top === 'hoodie' || top === 'jacket') add(ell(inC(J.waist, J.Rc, [0, P.ribs.off - 1, -0.1]), J.Rc, [P.ribs.r[0] + 0.45, P.ribs.r[1] + 1.4, P.ribs.r[2] + 0.4], 0, 'torso', tm));
    if (top === 'jacket') add(ell(inC(J.pelvis, J.Rp, [0, 0.4, 0]), J.Rp, [P.pelvisR[0] + 0.45, P.pelvisR[1] + 0.6, P.pelvisR[2] + 0.4], 0, 'torso', tm));
    if (bot === 'skirt') {
      add(cone(inC(J.pelvis, J.Rp, [0, 0.6, 0]), inC(J.pelvis, J.Rp, [0, -9.5, 0.3]), P.pelvisR[0] + 0.3, P.pelvisR[0] + 2.1, mi.bottom, 'skirt',
        { sz: 0.72, zHint: m3.col(J.Rp, 2) }));
    }

    // neck and collars
    add(cone(J.neckBase, J.neckTop, P.neckR, P.neckR * 0.95, mi.skin, 'neck'));
    if (top === 'buttonshirt' || top === 'jacket') {
      for (const s of [1, -1]) {
        const a = inC(J.waist, J.Rc, [s * 1.7, P.neckOff + 0.4, 1.0]), b = inC(J.waist, J.Rc, [s * 2.4, P.neckOff - 2.4, P.ribs.r[2] * 0.8]);
        add(cone(a, b, 0.75, 0.55, top === 'jacket' ? mi.top : mi.topAcc, 'collar' + s, { sz: 0.6, zHint: m3.col(J.Rc, 2) }));
      }
    }
    if (top === 'hoodie' && hat !== 'hood') add(ell(inC(J.waist, J.Rc, [0, P.neckOff + 0.3, -2.4]), J.Rc, [3.3, 1.7, 2.1], mi.topAcc, 'hood'));
    if (cfg.extras.scarf) {
      add(ell(inC(J.neckBase, J.Rc, [0, 0.5, 0.2]), J.Rc, [3.0, 1.25, 2.85], mi.scarf, 'scarf'));
      add(cone(inC(J.neckBase, J.Rc, [0.9, 0, 2.4]), inC(J.neckBase, J.Rc, [1.4, -3.4, 3.0]), 0.75, 0.55, mi.scarf, 'scarf'));
    }

    // ---------- arms ----------
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const sh = J['shoulder' + side], el = J['elbow' + side], wr = J['wrist' + side], tip = J['hand' + side];
      const id = side;
      add(cone(sh, el, P.upperArmR[0], P.upperArmR[1], mi.skin, 'upper' + id));
      // deltoid: the round cap that makes the shoulder read as a shoulder, under the sleeve if there is one
      add(ell(v3.lerp(sh, el, 0.12), J['Ru' + side], [P.upperArmR[0] * 1.18, P.upperArmR[0] * 1.35, P.upperArmR[0] * 1.12],
        sleeveUpper > 0 ? mi.top : mi.skin, sleeveUpper > 0 ? 'sleeve' + id : 'upper' + id));
      add(cone(el, wr, P.foreArmR[0], P.foreArmR[1], mi.skin, 'fore' + id));
      const handMat = cfg.extras.gloves ? mi.glove : mi.skin;
      add(cone(wr, tip, P.handR[0], P.handR[1], handMat, 'hand' + id));
      if (sleeveUpper > 0) {
        const end = v3.lerp(sh, el, Math.min(1, sleeveUpper));
        const rEnd = SS.lerp(P.upperArmR[0], P.upperArmR[1], Math.min(1, sleeveUpper)) + 0.5;
        const cuffFrom = top === 'buttonshirt' ? 0.74 : top === 'tshirt' ? 0.82 : 2;
        add(cone(v3.lerp(sh, el, 0.06), end, P.upperArmR[0] + 0.4, rEnd, mi.top, 'sleeve' + id, {
          matFn: (lp, info) => zomb(info.s > cuffFrom ? mi.topAcc : mi.top, info.s * 5 | 0, (info.ang + 4) * 1.5 | 0, 11 + s),
        }));
        if (sleeveFore > 0) {
          add(cone(el, v3.lerp(el, wr, 0.97), P.foreArmR[0] + 0.5, P.foreArmR[1] + 0.48, mi.top, 'sleeveF' + id, {
            matFn: (lp, info) => zomb(info.s > 0.84 ? mi.topAcc : mi.top, info.s * 5 | 0, (info.ang + 4) * 1.5 | 0, 13 + s),
          }));
        }
      }
    }

    // ---------- legs ----------
    const pantsShin = bot === 'jeans' || bot === 'cargo' || bot === 'overalls';
    for (const [side, s] of [['L', 1], ['R', -1]]) {
      const hip = J['hip' + side], kn = J['knee' + side], an = J['ankle' + side];
      const thighMat = (lp, info) => {
        let m = bot === 'skirt' ? mi.skin : mi.bottom;
        if (bot === 'shorts' && info.s > 0.8) m = mi.skin;
        // cargo pockets on the outer thigh
        if (bot === 'cargo' && info.s > 0.42 && info.s < 0.74 && s * info.lz > 0.55 * info.r) m = mi.bottomAcc;
        return zomb(m, info.s * 5 | 0, (info.ang + 4) * 1.6 | 0, 20 + s);
      };
      add(cone(hip, kn, P.thighR[0] + (bot === 'shorts' ? 0.35 : 0), P.thighR[1] + 0.15, 0, 'thigh' + side, { matFn: thighMat, zHint: m3.col(J.Rp, 0) }));
      const shinMat = (lp, info) => {
        let m = pantsShin ? mi.bottom : mi.skin;
        if (pantsShin && info.s > 0.9) m = mi.bottomAcc;
        return zomb(m, info.s * 5 | 0, (info.ang + 4) * 1.6 | 0, 30 + s);
      };
      add(cone(kn, an, P.shinR[0] + (pantsShin ? 0.32 : 0), P.shinR[1] + (pantsShin ? 0.55 : 0), 0, 'shin' + side, { matFn: shinMat }));
      // quadriceps bulge on the front of the thigh, calf bulge on the back of the shin (widest a third down)
      const fwd = m3.col(J.Rp, 2);
      const Rt = m3.frameY(v3.sub(kn, hip), fwd), Rs = m3.frameY(v3.sub(an, kn), fwd);
      const legMat = bot === 'skirt' ? mi.skin : mi.bottom;
      add(ell(v3.add(v3.lerp(hip, kn, 0.45), m3.v(Rt, [0, 0, 0.9])), Rt, [P.thighR[0] * 0.92, 3.6, P.thighR[0] * 0.8], legMat, 'thigh' + side));
      add(ell(v3.add(v3.lerp(kn, an, 0.3), m3.v(Rs, [0, 0, -0.75])), Rs, [P.shinR[0] * 0.95 + (pantsShin ? 0.3 : 0), 2.8, P.shinR[0] * 0.85 + (pantsShin ? 0.3 : 0)], pantsShin ? mi.bottom : mi.skin, 'shin' + side));
      // feet
      const Rf = J['Rfoot' + side];
      const heel = v3.add(an, m3.v(Rf, [0, -P.ankleY + P.footR[0], -P.heelBack + P.footR[0]]));
      const toe = v3.add(an, m3.v(Rf, [0, -P.ankleY + P.footR[1], P.footLen - P.heelBack - P.footR[1]]));
      const shoe = cfg.shoes.type;
      const footMat = (lp, info) => {
        if (shoe === 'barefoot') return mi.skin;
        if (info.lz < -0.62 * info.r) return mi.sole;
        if (shoe === 'sneakers' && info.s > 0.82 && info.lz > -0.2) return mi.sole;
        return mi.shoe;
      };
      add(cone(heel, toe, P.footR[0], P.footR[1], 0, 'foot' + side, { sx: P.footW, zHint: m3.col(Rf, 1), matFn: footMat }));
      if (shoe === 'boots') add(cone(v3.add(an, m3.v(Rf, [0, -1.0, -0.2])), v3.lerp(an, kn, 0.3), P.shinR[1] + 0.75, P.shinR[1] + 0.7, mi.shoe, 'boot' + side,
        { matFn: (lp, info) => (info.s > 0.84 ? mi.sole : mi.shoe) }));
    }

    // ---------- head ----------
    const Rh = J.Rh, hc = J.head, hr = P.headR;
    const hp = (v) => v3.add(hc, m3.v(Rh, v));
    const facial = cfg.face.facial;
    const jawMat = (lp) => (facial === 'stubble' && lp[2] > -1.6 && lp[1] < 0.6 - Math.max(0, lp[2]) * 0.12 ? mi.stubble : mi.skin);
    add(ell(hc, Rh, hr.slice(), mi.skin, 'head'));
    add(ell(hp([0, -2.0, 0.75]), Rh, [hr[0] * 0.9, hr[1] * 0.6, hr[2] * 0.84], mi.skin, 'head', { matFn: jawMat }));
    // profile: brow ridge, a nose that slopes forward from the bridge, and a chin, so the side view reads as a face
    // the face plane stands about a pixel proud of the skull, so the eyes sit back from the profile line
    const faceC = [0, -1.2, 1.2], faceR = [3.0, 3.0, 4.2];
    add(ell(hp(faceC), Rh, faceR, mi.skin, 'head', { matFn: jawMat }));
    add(ell(hp([0, 0.75, hr[2] + 0.3]), Rh, [2.7, 0.6, 0.85], mi.skin, 'head'));
    add(cone(hp([0, 0.0, hr[2] + 0.9]), hp([0, -1.25, hr[2] + 1.45]), 0.45, 0.5, mi.skin, 'head'));
    add(ell(hp([0, -3.5, hr[2] - 0.1]), Rh, [1.5, 0.95, 0.95], mi.skin, 'head', { matFn: (lp) => (facial === 'stubble' ? mi.stubble : mi.skin) }));
    for (const s of [1, -1]) add(ell(hp([s * (hr[0] - 0.25), -0.55, -0.35]), Rh, [0.85, 1.3, 0.7], mi.skin, 'head'));
    if (facial === 'beard') {
      add(ell(hp([0, -2.4, 1.15]), Rh, [hr[0] * 0.86, hr[1] * 0.62, hr[2] * 0.84], mi.hair, 'beard',
        { clip: (lp) => lp[1] < 0.9 - Math.max(0, lp[2]) * 0.25 && lp[2] > -1.2 }));
    }
    if (facial === 'beard' || facial === 'mustache') add(cone(hp([-1.45, -1.9, hr[2] - 0.45]), hp([1.45, -1.9, hr[2] - 0.45]), 0.5, 0.5, mi.hair, 'beard'));

    // hair
    const hairline = (lp, front, side, back) => {
      const th = Math.atan2(lp[0], lp[2]);
      const w = (1 + Math.cos(th)) / 2, sn = Math.sin(th) ** 2;
      const mid = (front + back) / 2;
      return lp[1] > back + (front - back) * w + (side - mid) * sn;
    };
    const capOn = !(hat === 'hood');
    const style = cfg.hair.style;
    const addCap = (off, up, front, side, back, mat = mi.hair) => {
      const c = hp([0, up, -0.05]);
      add(ell(c, Rh, [hr[0] + off[0], hr[1] + off[1], hr[2] + off[2]], mat, 'hair', {
        clip: (lp) => hairline([lp[0], lp[1] + up, lp[2]], front, side, back),
      }));
    };
    const hairSway = pose.hair || 0;
    const tuft = (a, b, ra, rb) => {
      const bb = [b[0], b[1], b[2] + hairSway * 0.45];
      add(cone(hp(a), hp(bb), ra, rb, mi.hair, 'hair'));
    };
    if (capOn && style !== 'bald') {
      if (style === 'buzz') addCap([0.22, 0.28, 0.22], 0.1, 2.5, 1.1, -2.3);
      else if (style === 'short') addCap([0.5, 0.62, 0.5], 0.3, 2.25, 0.65, -2.6);
      else if (style === 'messy') {
        addCap([0.5, 0.95, 0.5], 0.45, 1.9, 0.6, -3.6);
        // sideburns down to the jaw in front of the ears
        for (const s of [1, -1]) add(cone(hp([s * (hr[0] - 0.35), 0.4, 0.9]), hp([s * (hr[0] - 0.75), -2.3, 1.2]), 0.75, 0.55, mi.hair, 'hair'));
        if (!coverHead) {
          tuft([0.5, 3.9, 1.4], [1.7, 5.9, 2.4], 1.15, 0.45);
          tuft([-1.4, 4.1, 0.3], [-2.3, 5.6, -0.3], 1.05, 0.4);
          tuft([1.4, 3.4, -1.9], [2.5, 4.7, -3.3], 0.95, 0.4);
        }
        tuft([2.0, 2.7, 3.5], [3.1, 1.5, 4.4], 0.85, 0.42);
      } else if (style === 'swept') {
        addCap([0.55, 0.7, 0.55], 0.35, 2.3, 0.6, -2.6);
        add(cone(hp([-2.4, 3.3, 3.0]), hp([2.7, 1.9 - hairSway * 0.2, 4.15]), 1.25, 0.8, mi.hair, 'hair'));
      } else if (style === 'bob') addCap([0.85, 0.8, 0.85], 0.15, 0.9, -3.5, -4.3);
      else if (style === 'long') {
        addCap([0.75, 0.75, 0.75], 0.2, 1.6, -4.0, -6);
        add(cone(hp([0, -1.2, -3.2]), hp([hairSway * 0.4, -10.2, -3.6 - Math.abs(hairSway) * 0.3]), 4.3, 3.2, mi.hair, 'hair', { sz: 0.5, zHint: m3.col(Rh, 2) }));
        for (const s of [1, -1]) add(cone(hp([s * 3.9, -0.4, 0.4]), hp([s * 4.3, -8.6, -0.6 + hairSway * 0.3]), 1.35, 0.95, mi.hair, 'hair'));
      } else if (style === 'ponytail') {
        addCap([0.5, 0.62, 0.5], 0.3, 2.2, 0.75, -2.2);
        add(ell(hp([0, 1.2, -hr[2] - 0.2]), Rh, [1.05, 1.05, 0.9], mi.hair, 'hair'));
        const t0 = hp([0, 0.9, -hr[2] - 0.7]);
        const t1 = hp([hairSway * 0.9, -3.4, -hr[2] - 2.0]);
        const t2 = hp([hairSway * 1.7, -7.2, -hr[2] - 1.4 + Math.abs(hairSway) * 0.5]);
        add(cone(t0, t1, 1.3, 0.95, mi.hair, 'tail'));
        add(cone(t1, t2, 0.95, 0.5, mi.hair, 'tail'));
      } else if (style === 'mohawk') {
        addCap([0.12, 0.15, 0.12], 0, 2.4, 1.0, -2.4, mi.stubble);
        if (!coverHead) {
          add(cone(hp([0, 4.2, 2.7]), hp([0, 4.9, -0.6]), 1.45, 1.45, mi.hair, 'hair', { sx: 0.6, zHint: m3.col(Rh, 0) }));
          add(cone(hp([0, 4.9, -0.6]), hp([0, 2.9, -4.3]), 1.45, 1.2, mi.hair, 'hair', { sx: 0.6, zHint: m3.col(Rh, 0) }));
        }
      } else if (style === 'afro') addCap([coverHead ? 0.8 : 1.9, coverHead ? 0.8 : 1.5, coverHead ? 0.8 : 1.7], coverHead ? 0.3 : 1.0, 1.8, 0.0, -3.0);
    }

    // hats
    if (hat === 'cap') {
      add(ell(hp([0, 0.7, -0.15]), Rh, [hr[0] + 0.6, hr[1] - 0.2, hr[2] + 0.6], mi.hat, 'hat', { clip: (lp) => lp[1] + 0.7 > 1.0 }));
      add(ell(hp([0, 1.25, hr[2] - 0.2]), m3.mul(Rh, m3.rx(10 * D2R)), [3.2, 0.42, 2.9], mi.hatAcc, 'brim', { clip: (lp) => lp[2] > -1.2 }));
    } else if (hat === 'beanie') {
      add(ell(hp([0, 0.85, -0.15]), Rh, [hr[0] + 0.6, hr[1] + 0.45, hr[2] + 0.6], mi.hat, 'hat', { clip: (lp) => lp[1] + 0.85 > 0.75 }));
      add(cone(hp([0, 0.55, -0.15]), hp([0, 1.65, -0.15]), hr[0] + 0.7, hr[0] + 0.62, mi.hatAcc, 'hat', { sz: (hr[2] + 0.7) / (hr[0] + 0.7), zHint: m3.col(Rh, 2) }));
    } else if (hat === 'bandana') {
      add(cone(hp([0, 1.9, 0]), hp([0, 3.0, -0.2]), hr[0] + 0.32, hr[0] + 0.05, mi.hat, 'hat', { sz: hr[2] / hr[0], zHint: m3.col(Rh, 2) }));
      add(cone(hp([0.6, 2.3, -hr[2] - 0.1]), hp([1.6 + hairSway, -0.6, -hr[2] - 0.9]), 0.65, 0.45, mi.hat, 'hat'));
    } else if (hat === 'hood') {
      const hoodMat = top === 'hoodie' ? mi.top : mi.hat;
      add(ell(hp([0, 0.45, -0.55]), Rh, [hr[0] + 1.25, hr[1] + 1.4, hr[2] + 1.3], hoodMat, 'hood', {
        clip: (lp) => !(lp[2] > 0.5 && Math.abs(lp[0]) < 3.5 && lp[1] + 0.45 < 2.5),
      }));
    } else if (hat === 'strawhat') {
      add(ell(hp([0, 2.5, -0.1]), Rh, [hr[0] - 0.1, 3.0, hr[2] - 0.1], mi.hat, 'hat', { clip: (lp) => lp[1] + 2.5 > 1.6 }));
      add(cone(hp([0, 1.6, -0.1]), hp([0, 2.5, -0.1]), hr[0] + 0.05, hr[0] - 0.1, mi.hatAcc, 'hat', { sz: 1, zHint: m3.col(Rh, 2) }));
      add(ell(hp([0, 1.55, 0.2]), m3.mul(Rh, m3.rx(6 * D2R)), [7.4, 0.5, 7.0], mi.hat, 'brim'));
    }

    // ---------- accessories ----------
    if (cfg.extras.backpack) {
      const back = -(P.ribs.r[2] + 2.0);
      add(ell(inC(J.waist, J.Rc, [0, P.ribs.off + 0.4, back]), J.Rc, [4.1, 4.7, 2.2], mi.pack, 'pack'));
      add(ell(inC(J.waist, J.Rc, [0, P.ribs.off + 3.9, back + 0.35]), J.Rc, [3.7, 1.3, 2.0], mi.strap, 'pack'));
      for (const s of [1, -1]) {
        const x = s * 2.75;
        const fy = P.ribs.off - 3.0;
        const fz = surfZ(P.ribs.r, x, fy - P.ribs.off) + 0.25;
        const pts = [[x, P.ribs.off + 3.6, back + 1.6], [s * 3.2, P.shoulderBar.off + 1.6, -0.6], [x * 1.04, P.ribs.off + 2.6, surfZ(P.ribs.r, x, 2.6) + 0.35], [x, fy, fz]];
        for (let i = 0; i < pts.length - 1; i++) add(cone(inC(J.waist, J.Rc, pts[i]), inC(J.waist, J.Rc, pts[i + 1]), 0.6, 0.6, mi.strap, 'strap' + s));
      }
    }

    // ---------- weapon (right hand) and smears ----------
    const wtype = cfg.weapon.type;
    const weaponParts = (Jx, pz) => {
      const Rw = Jx.RwR;
      const dir = v3.norm(m3.v(m3.mul(Rw, m3.rx(-(pz.cock || 0) * D2R)), [0, -1, 0]));
      const grip = v3.lerp(Jx.wristR, Jx.handR, 0.55);
      const side = m3.col(Rw, 0);
      return { dir, grip, side };
    };
    if (wtype !== 'none') {
      const { dir, grip, side } = weaponParts(J, pose);
      const at = (d) => v3.mad(grip, dir, d);
      const thin = { sz: 0.32, zHint: side };
      if (wtype === 'machete') {
        add(cone(at(-1.5), at(1.3), 0.6, 0.55, mi.grip, 'weapon'));
        add(cone(at(1.5), at(10.2), 1.0, 0.8, mi.metal, 'weapon', thin));
      } else if (wtype === 'bat') add(cone(at(-1.8), at(11), 0.62, 1.2, mi.wood, 'weapon'));
      else if (wtype === 'pipe') add(cone(at(-1.6), at(10), 0.62, 0.62, mi.metal, 'weapon'));
      else if (wtype === 'axe') {
        add(cone(at(-1.6), at(9.2), 0.55, 0.55, mi.wood, 'weapon'));
        const perp = v3.norm(v3.cross(dir, side));
        add(ell(v3.mad(at(8.4), perp, 1.3), m3.frameY(dir, side), [1.6, 1.3, 0.5], mi.metal, 'weapon'));
      }
    }
    if (pose.smearFrom) {
      // copies of the blade swept from the previous key: an angular smear, never on anticipation or recover
      for (let i = 1; i <= 7; i++) {
        const t = i / 8;
        const pz = SS.blendPose(pose.smearFrom, pose, t);
        const Jx = SS.solve(P, pz);
        if (wtype === 'none') {
          add(cone(Jx.wristR, Jx.handR, P.handR[0] * 1.15, P.handR[1] * 1.1, mi.smear, 'smear'));
        } else {
          const { dir, grip } = weaponParts(Jx, pz);
          const len = wtype === 'bat' ? 11 : wtype === 'axe' ? 9.5 : 10;
          add(cone(v3.mad(grip, dir, 3.0), v3.mad(grip, dir, len), 1.25, 1.05, mi.smear, 'smear'));
        }
      }
    }

    // ---------- decals ----------
    const eyeY = -0.4, eyeX = 1.8 * (hr[0] / 4.45), browY = 1.05;
    const faceZ = (x, y) => Math.max(surfZ(hr, x, y), faceC[2] + surfZ(faceR, x - faceC[0], y - faceC[1]) * (Math.abs(y - faceC[1]) < faceR[1] && Math.abs(x) < faceR[0] ? 1 : 0));
    const browZ = (x) => Math.max(faceZ(x, browY), hr[2] + 0.3 + surfZ([2.7, 0.6, 0.85], x, browY - 0.75));
    for (const s of [1, -1]) {
      decals.push({ p: hp([s * eyeX, eyeY, faceZ(s * eyeX, eyeY) - 0.9]), obj: 'head', mat: mi.eye, shade: 2, kind: 'eye' });
      if (!(coverHead && hat !== 'cap')) {
        decals.push({ p: hp([s * (eyeX + 0.5), browY, browZ(s * (eyeX + 0.5))]), obj: 'head', mat: mi.brow, shade: 1, kind: 'brow' });
        decals.push({ p: hp([s * (eyeX - 0.45), browY, browZ(s * (eyeX - 0.45))]), obj: 'head', mat: mi.brow, shade: 1, kind: 'brow' });
      }
    }
    if (facial !== 'beard' && facial !== 'mustache') {
      for (const s of [1, -1]) decals.push({ p: hp([s * 0.45, -2.75, faceZ(s * 0.45, -2.75)]), obj: 'head', mat: mi.mouth, shade: 2, kind: 'mouth' });
    }
    if (cfg.extras.glasses) {
      for (let x = -2.9; x <= 2.91; x += 0.58) decals.push({ p: hp([x, eyeY + 0.1, surfZ(hr, x, eyeY) + 0.25]), obj: 'head', mat: mi.lens, shade: 1, kind: 'glasses' });
    }
    const front = (x, y, extra = 0) => inC(J.waist, J.Rc, [x, y, surfZ(P.ribs.r, x, y - P.ribs.off) + 0.15 + extra]);
    if (top === 'buttonshirt' && !(Z && Z.torn > 0.6)) for (const y of [8.0, 5.6, 3.2, 0.8]) decals.push({ p: front(0, y), obj: 'torso', mat: mi.top, shade: 4, kind: 'button' });
    if (top === 'hoodie') for (const s of [1, -1]) {
      decals.push({ p: front(s * 0.9, P.neckOff - 2.6), obj: 'torso', mat: mi.under, shade: 3, kind: 'string' });
      decals.push({ p: front(s * 0.9, P.neckOff - 3.6), obj: 'torso', mat: mi.under, shade: 3, kind: 'string' });
    }
    if (cfg.extras.belt && bot !== 'skirt' && (top !== 'tshirt' && top !== 'hoodie')) {
      const by = -2.05;
      const bz = surfZ(P.abdomen.r, 0, by - P.abdomen.off) + 0.2;
      decals.push({ p: inC(J.waist, J.Rm, [-0.3, by, bz]), obj: 'torso', mat: mi.buckle, shade: 3, kind: 'buckle' });
      decals.push({ p: inC(J.waist, J.Rm, [0.4, by, bz]), obj: 'torso', mat: mi.buckle, shade: 2, kind: 'buckle' });
    }
    if (bot === 'overalls') for (const s of [1, -1]) decals.push({ p: front(s * 2.6, 6.9, 0.1), obj: 'torso', mat: mi.buckle, shade: 3, kind: 'button' });

    return { prims, decals };
  };

  // rotate a character-space build into camera space for a view yaw (degrees; 0 faces the viewer)
  SS.toCamera = (build, yawDeg) => {
    const Rv = m3.ry(yawDeg * D2R);
    const P = (p) => m3.v(Rv, p);
    const prims = build.prims.map((p) => {
      const q = Object.assign({}, p);
      if (p.type === 0) {
        q.c = P(p.c); q.R = m3.mul(Rv, p.R);
      } else {
        q.a = P(p.a); q.b = P(p.b);
        q.L = v3.dist(q.a, q.b);
        const zh = p.zHint ? P(p.zHint) : m3.v(Rv, [0, 0, 1]);
        q.R = m3.frameY(v3.sub(q.b, q.a), zh);
        // one end sphere swallows the other: the intersector needs L > |ra - rb|, so keep the big ball
        if (q.L <= Math.abs(p.ra - p.rb) + 0.02) {
          const big = p.ra >= p.rb;
          q.type = 0; q.c = big ? q.a : q.b;
          const r = Math.max(p.ra, p.rb);
          q.r = [r * p.sx, r, r * p.sz];
          q.matFn = null;
        }
      }
      if (p.mframe) q.mframe = { o: P(p.mframe.o), R: m3.mul(Rv, p.mframe.R) };
      return q;
    });
    const decals = build.decals.map((d) => Object.assign({}, d, { p: P(d.p) }));
    return { prims, decals };
  };
})(window.SS);
