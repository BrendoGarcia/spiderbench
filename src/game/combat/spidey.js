// OWNER: combat engineer. Spider-Man's side of combat: move set, motion (lunges, dodges, air juggles) and animation.
// Motion is applied through the traversal state inside the C5 control override (runs before traversal integrates, so
// traversal's capsule collision / ground snap still apply on the ground); airborne combat moves drive the capsule with
// one-frame scripted `kin` segments (no gravity while juggling). Animation = PoseLayer (combat clip stack over the
// animation layer's output).
//
// Moves: strike (combo punch1 > punch2 > punch3 > kick ender; lunges up to 8 m, flying kick beyond 3.4 m) · launcher
// (hold LMB: uppercut, jump with the enemy) · air combo (LMB in air: 3 hits, the third slams) · air slam (hold LMB in air)
// · dive strike (LMB while airborne near enemies) · dodge / perfect dodge · web strike (E) · web shooter (F) ·
// environmental throw (R) · finisher (Q, 1 focus) · heal (Z, 1 focus) · hit reactions / knockdown + get-up.
import * as THREE from 'three';
import { PoseLayer } from './poselayer.js';
import { clamp, smooth, lerp, yawTo, hdist, angWrap, UP } from './util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const H = 0.95;
// Ground combo: each step picks from a pool (never the same clip twice in a row); step 4 is an ender.
const MOVES = {
  jab: { clip: 'punch1', hit: 0.20, ts: 1.35, reach: 0.95, dmg: 9, kind: 'light' },
  cross: { clip: 'punch2', hit: 0.23, ts: 1.35, reach: 0.95, dmg: 10, kind: 'light' },
  hook: { clip: 'punch3', hit: 0.30, ts: 1.4, reach: 1.0, dmg: 11, kind: 'light' },
  kickL: { clip: 'kick', hit: 0.30, ts: 1.45, reach: 1.1, dmg: 11, kind: 'light' },
  hopKick: { clip: 'webStrike', from: 0.40, hit: 0.57, ts: 1.1, reach: 1.05, dmg: 12, kind: 'light' },
  airPunch: { clip: 'airCombo', from: 0.05, until: 0.3, hit: 0.13, ts: 1.0, reach: 0.95, dmg: 10, kind: 'light' },
  roundhouse: { clip: 'kick', hit: 0.30, ts: 1.2, reach: 1.1, dmg: 16, kind: 'ender' },
  spinKick: { clip: 'finisher', from: 0.22, until: 0.9, hit: 0.57, ts: 1.35, reach: 1.1, dmg: 18, kind: 'ender' },
  flipKick: { clip: 'airCombo', from: 0.42, until: 0.8, hit: 0.60, ts: 1.15, reach: 1.05, dmg: 17, kind: 'ender' },
};
const POOLS = [['jab', 'cross', 'airPunch'], ['cross', 'hook', 'kickL'], ['hook', 'kickL', 'hopKick', 'jab'], ['roundhouse', 'spinKick', 'flipKick']];
const COMBO = POOLS.map(p => MOVES[p[0]]);
const AIR = [ // airCombo segments
  { from: 0.0, until: 0.22, hit: 0.13, dmg: 9, kind: 'air' },
  { from: 0.2, until: 0.42, hit: 0.27, dmg: 9, kind: 'air' },
  { from: 0.42, until: 0.8, hit: 0.60, dmg: 14, kind: 'slam' },
];

export function createSpidey(c) {
  const ctx = c.ctx, P = ctx.player, s = P.state, rig = P.rig;
  const layer = new PoseLayer(rig);
  const M = { name: 'free', t: 0 }; // current move
  const me = {
    layer, M, hp: 100, maxHp: 100, focus: 0, invulnUntil: 0, comboStep: 0, comboT: 0, lastAttackT: -9, target: null,
    airborne: false, counterUntil: 0, downed: false,
  };
  const feet = () => _v3.set(s.pos.x, s.pos.y - H, s.pos.z);
  const an = () => rig.animator;
  function face(yaw, snap = false) {
    s.facing = yaw; s.speed = 0;
    if (snap && an()) { an().yaw = yaw; }
  }
  function kinTo(p) { // move the capsule centre to p this frame (no gravity / ground snap)
    s.kin = { type: 'cmb', t: 0, dur: 1e-4, p0: s.pos.clone(), p1: s.pos.clone().lerp(p, 0.5), p2: p.clone() };
    s.vel.set(0, 0, 0);
  }
  function groundXZ(x, z) { s.pos.x = x; s.pos.z = z; s.speed = 0; s.vel.set(0, 0, 0); }
  function start(name, o = {}) { for (const k of Object.keys(M)) delete M[k]; Object.assign(M, { name, t: 0, hitDone: false, ...o }); }
  function free(fade = 0.22) { for (const k of Object.keys(M)) delete M[k]; M.name = 'free'; M.t = 0; layer.stop(fade); s.kin = null; }
  const onGround = () => s.mode === 'ground' && !s.kin;
  me.isFree = () => M.name === 'free';
  me.busy = () => M.name !== 'free';
  me.invuln = () => c.time < me.invulnUntil || M.name === 'dodge' && M.t < 0.5 || M.name === 'finisher' || M.name === 'down' || M.name === 'throw' && M.t < 0.75;

  // ------------------------------------------------------------------ strike (ground combo, lunge)
  let lastMove = '';
  function chooseMove(step, target) {
    // directional variant: enemy behind / beside Spidey -> turning roundhouse; mid-range -> hop kick
    const P0 = feet(); const to = Math.atan2(target.pos.x - P0.x, target.pos.z - P0.z);
    const off = Math.abs(angWrap(to - s.facing)), d = hdist(P0, target.pos);
    if (step < 3 && off > 2.0) return 'kickL';
    if (step < 3 && d > 2.2 && d < 3.4 && lastMove !== 'hopKick') return 'hopKick';
    const pool = POOLS[step].filter(k => k !== lastMove);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function strike(target, step) {
    const key = chooseMove(step, target); lastMove = key;
    const S = MOVES[key];
    const P0 = feet().clone();
    const d = Math.max(0, hdist(P0, target.pos) - S.reach);
    const long = d > 3.4;
    const dir0 = _v.set(P0.x - target.pos.x, 0, P0.z - target.pos.z).normalize().clone();
    let clip = S.clip, from = S.from || 0, until = S.until ?? null, hit = S.hit, ts = S.ts, kind = S.kind, dmg = S.dmg;
    if (long) { clip = 'webStrike'; from = 0.32; hit = 0.57; until = null; } // flying kick for long lunges
    const travel = long ? clamp(d / 17, 0.22, 0.5) : clamp(d / 9, 0, 0.2);
    const toHit = (hit - from) / ts;
    if (travel > toHit) ts = (hit - from) / travel;
    const counter = c.time < me.counterUntil;
    if (counter) { dmg *= 1.6; if (kind === 'light') kind = 'ender'; me.counterUntil = 0; }
    start('strike', { target, clip, from, hit, ts, kind, dmg, P0, dir0, reach: S.reach, until, arrive: Math.max(0.06, Math.min(travel, (hit - from) / ts) * 0.95), long, step, pressT: c.time });
    layer.play(clip, { from, until: until ?? undefined, ts, fade: step === 0 && !long ? 0.07 : 0.06 });
    face(yawTo(P0, target.pos), true);
    me.target = target; me.lastAttackT = c.time;
    if (long) { c.sfx('whoosh', 18); }
  }
  function launcher(target) {
    const P0 = feet().clone();
    const dir0 = _v.set(P0.x - target.pos.x, 0, P0.z - target.pos.z).normalize().clone();
    start('launch', { target, clip: 'uppercut', from: 0, hit: 0.33, ts: 1.25, kind: 'launch', dmg: 10, P0, dir0, reach: 1.0, arrive: 0.2, rise: false });
    layer.play('uppercut', { ts: 1.25, fade: 0.07 });
    face(yawTo(P0, target.pos), true); me.target = target; me.lastAttackT = c.time;
  }
  function airStrike(target, seg, forceSlam = false) {
    const A = AIR[forceSlam ? 2 : seg];
    start('airStrike', { target, seg: forceSlam ? 2 : seg, A, hit: A.hit, ts: 1.2 });
    layer.play('airCombo', { from: A.from, until: A.until, ts: 1.2, fade: 0.06 });
    me.target = target; me.lastAttackT = c.time;
  }
  function diveStrike(target) {
    const P0 = s.pos.clone();
    start('dive', { target, P0, hit: 0.57, from: 0.3, ts: 1, arrive: clamp(P0.distanceTo(target.pos) / 22, 0.2, 0.6) });
    M.ts = (0.57 - 0.3) / M.arrive;
    layer.play('webStrike', { from: 0.3, ts: M.ts, fade: 0.08 });
    face(yawTo(P0, target.pos), true); me.target = target;
    c.sfx('whoosh', 22);
  }
  function webStrike(target) {
    const P0 = s.pos.clone();
    const d = hdist(P0, target.pos);
    const fly = clamp(d / 24, 0.2, 0.55);
    start('webStrike', { target, P0, hit: 0.57, fly, pulled: false });
    M.ts2 = (0.57 - 0.3) / fly;
    layer.play('webStrike', { from: 0.05, until: 0.3, ts: 1.4, fade: 0.07 });
    face(yawTo(P0, target.pos), true); me.target = target;
    c.fx.strand(() => rig.handWorld('R', new THREE.Vector3()), () => target.chest(new THREE.Vector3()), { life: 0.32, sag: 0.05, fade: 0.1 });
    c.sfx('thwip', 1.2);
  }
  function dodge(threatDir, perfect, inputDir) {
    // threatDir: horizontal unit from Spidey toward the attacker; side flip when the stick points sideways
    let side = false, yaw, move;
    if (inputDir && inputDir.lengthSq() > 0.1) {
      const lat = Math.abs(inputDir.x * threatDir.z - inputDir.z * threatDir.x);
      if (lat > 0.55 || !threatDir.lengthSq()) side = true;
      move = inputDir.clone().normalize();
    } else move = threatDir.lengthSq() ? threatDir.clone().negate() : new THREE.Vector3(-Math.sin(s.facing), 0, -Math.cos(s.facing));
    if (side) yaw = Math.atan2(-move.z, move.x); // local +X (his left) along the move
    else yaw = Math.atan2(-move.x, -move.z);     // back flip: face opposite to the move
    start('dodge', { move, side, dist: side ? 3.2 : 3.4, P0: feet().clone(), perfect });
    layer.play(side ? 'dodgeSide' : 'dodge', { ts: side ? 1.35 : 1.45, fade: 0.05 });
    face(yaw, true);
    me.invulnUntil = c.time + 0.55;
    c.sfx('whoosh', 16);
    if (perfect) { me.counterUntil = c.time + 1.4; }
  }
  function webShoot(target) {
    layer.play('webShootR', { ts: 1.5, fade: 0.06, mask: 'upper', id: 'shoot', hold: false });
    M.shootT = c.time; M.shootTarget = target;
    c.pendingShot = { at: c.time + 0.09, target };
  }
  function throwProp(prop, target) {
    start('throw', { prop, target, released: false });
    layer.play('webShootR', { ts: 1.3, fade: 0.06 });
    face(yawTo(feet(), prop.pos), true);
    c.props.grab(prop, me);
    c.fx.strand(() => rig.handWorld('R', new THREE.Vector3()), () => prop.pos.clone(), { life: 0.5, sag: 0.08 });
    c.fx.strand(() => rig.handWorld('L', new THREE.Vector3()), () => prop.pos.clone(), { life: 0.5, sag: 0.1 });
    c.sfx('thwip', 1.0);
  }
  function finisher(target) {
    const P0 = feet().clone();
    const dir0 = _v.set(P0.x - target.pos.x, 0, P0.z - target.pos.z).normalize().clone();
    start('finisher', { target, P0, dir0, hit: 0.57, reach: 1.15, arrive: 0.4 });
    layer.play('finisher', { ts: 1, fade: 0.08 });
    face(yawTo(P0, target.pos), true); me.target = target;
    target.set('stagger'); target.stagT = 2; target.play('hitReact', { once: true, ts: 0.35, fade: 0.1 }); // held for the cinematic
    c.releaseToken(target); c.clearThreats(target);
    c.cine(target, 1.45);
  }
  function takeHit(e, dmg, heavy) {
    me.hp = Math.max(0, me.hp - dmg);
    const dir = _v.set(s.pos.x - e.pos.x, 0, s.pos.z - e.pos.z).normalize().clone();
    face(Math.atan2(-dir.x, -dir.z), true);
    s.kin = null; me.comboStep = 0;
    if (heavy || me.hp <= 0) {
      start('down', { dir, dist: 2.2, P0: feet().clone(), dead: me.hp <= 0 });
      layer.play('knockdown', { ts: 1.15, fade: 0.05 });
      me.invulnUntil = c.time + 2.4;
    } else {
      start('hit', { dir, dist: 0.7, P0: feet().clone() });
      layer.play('hitReact', { ts: 1.25, fade: 0.04 });
      me.invulnUntil = c.time + 0.45;
    }
  }
  me.takeHit = takeHit;

  // ------------------------------------------------------------------ per-frame motion (inside the control override)
  function contactPoint(t, dir0, reach, out) { return out.copy(t.pos).addScaledVector(dir0, reach); }
  function motion(dt) {
    M.t += dt;
    const tr = layer.top();
    switch (M.name) {
      case 'strike': case 'launch': case 'finisher': {
        const T = M.target;
        const u = clamp(M.t / M.arrive, 0, 1), e = 1 - (1 - u) * (1 - u);
        if (T.alive && M.t <= M.arrive + 0.02) {
          const cp = contactPoint(T, M.dir0, M.reach, _v2);
          const x = lerp(M.P0.x, cp.x, e), z = lerp(M.P0.z, cp.z, e);
          if (M.long) {
            const y = lerp(M.P0.y, T.pos.y, e) + H + Math.sin(Math.PI * u) * 0.55;
            if (u < 1) kinTo(_v.set(x, y, z)); else { s.kin = null; groundXZ(x, z); }
          } else groundXZ(x, z);
          face(yawTo(feet(), T.pos), M.t < 0.05);
        }
        const clipT = tr ? tr.t : 0;
        if (!M.hitDone && clipT >= M.hit - 0.001 && (M.name !== 'finisher' || M.t > 0.2)) {
          M.hitDone = true;
          if (M.name === 'finisher') c.playerHit(M.target, { kind: 'finisher', dmg: 999 });
          else c.playerHit(M.target, { kind: M.kind, dmg: M.dmg, heavy: M.kind !== 'light' ? 0.6 : 0.15 });
          if (M.name === 'launch' && M.target.state === 'air') { M.rise = true; M.riseT = 0; M.riseFrom = s.pos.clone(); }
        }
        if (M.name === 'launch' && M.rise) {
          M.riseT += dt;
          const T2 = M.target, k = smooth(M.riseT / 0.38);
          const want = _v.copy(T2.pos).addScaledVector(M.dir0, 1.0); want.y = T2.pos.y + H + 0.1;
          kinTo(_v2.copy(M.riseFrom).lerp(want, k));
          if (M.riseT > 0.38) { start('air', { target: T2, idleT: 0 }); layer.play('airCombo', { from: 0.0, until: 0.02, ts: 0.2, fade: 0.2 }); }
          return;
        }
        // chaining: input buffered after the hit frame
        const dur = tr ? tr.until : 0;
        if (clipT >= dur - 0.02 || (M.hitDone && M.name === 'strike' && clipT >= M.hit + 0.28)) {
          if (M.long && !onGround()) s.kin = null;
          free(M.long ? 0.3 : 0.25);
        }
        break;
      }
      case 'air': case 'airStrike': {
        const T = M.target;
        if (!T || !T.alive || (T.state !== 'air')) { free(0.3); break; }
        const dir = _v2.set(s.pos.x - T.pos.x, 0, s.pos.z - T.pos.z); if (dir.lengthSq() < 1e-4) dir.set(Math.sin(s.facing + Math.PI), 0, Math.cos(s.facing + Math.PI)); dir.normalize();
        const want = _v.copy(T.pos).addScaledVector(dir, 0.95); want.y = T.pos.y + H + 0.05;
        kinTo(_v.copy(s.pos).lerp(want, 1 - Math.exp(-14 * dt)));
        face(yawTo(feet(), T.pos));
        if (M.name === 'air') {
          M.idleT += dt;
          if (M.idleT > 0.9) { T.juggle = Math.min(T.juggle, 0); free(0.3); }
          break;
        }
        const clipT = tr ? tr.t : 0;
        if (!M.hitDone && clipT >= M.hit) {
          M.hitDone = true;
          c.playerHit(T, { kind: M.A.kind === 'slam' ? 'slam' : 'air', dmg: M.A.dmg, heavy: M.A.kind === 'slam' ? 0.9 : 0.25 });
          if (M.A.kind === 'slam') { start('slamDown', { from: s.pos.clone() }); break; }
        }
        if (M.hitDone && clipT >= M.A.until - 0.01) { start('air', { target: T, idleT: 0, seg: M.seg }); }
        break;
      }
      case 'slamDown': {
        const g = c.ctx.world.groundHeight(s.pos.x, s.pos.z, s.pos.y);
        const k = smooth(M.t / 0.22);
        kinTo(_v.copy(M.from).lerp(_v2.set(M.from.x, g + H, M.from.z), k));
        if (M.t >= 0.22) { s.kin = null; c.groundPound(feet().clone()); free(0.3); }
        break;
      }
      case 'dive': {
        const T = M.target; const u = clamp(M.t / M.arrive, 0, 1), e = u * u * (3 - 2 * u);
        if (T.alive) {
          const dir0 = _v2.set(M.P0.x - T.pos.x, 0, M.P0.z - T.pos.z).normalize();
          const cp = _v.copy(T.pos).addScaledVector(dir0, 1.05); cp.y = T.pos.y + H;
          kinTo(_v.copy(M.P0).lerp(cp, e).setY(lerp(M.P0.y, cp.y, e) + Math.sin(Math.PI * u) * 0.4));
          face(yawTo(feet(), T.pos));
        }
        if (!M.hitDone && u >= 1) { M.hitDone = true; s.kin = null; c.playerHit(T, { kind: 'strike', dmg: 16, heavy: 0.7 }); }
        if (M.t > M.arrive + 0.3) free(0.3);
        break;
      }
      case 'webStrike': {
        const T = M.target;
        if (!M.pulled && M.t >= 0.18) { M.pulled = true; M.flyT0 = M.t; M.P0 = s.pos.clone(); layer.play('webStrike', { from: 0.3, ts: M.ts2, fade: 0.06 }); c.sfx('whoosh', 26); }
        if (M.pulled && T.alive) {
          const u = clamp((M.t - M.flyT0) / M.fly, 0, 1), e = u * u * (3 - 2 * u);
          const dir0 = _v2.set(M.P0.x - T.pos.x, 0, M.P0.z - T.pos.z).normalize();
          const cp = _v.copy(T.pos).addScaledVector(dir0, 1.0); cp.y = T.pos.y + H + 0.1;
          if (u < 1) kinTo(_v.copy(M.P0).lerp(cp, e).setY(lerp(M.P0.y, cp.y, e) + Math.sin(Math.PI * u) * 0.9));
          face(yawTo(feet(), T.pos));
          if (!M.hitDone && u >= 1) { M.hitDone = true; s.kin = null; c.playerHit(T, { kind: 'strike', dmg: 20, heavy: 0.8, stunBrute: true }); }
        }
        if (M.hitDone && M.t > M.flyT0 + M.fly + 0.28) free(0.3);
        if (!T.alive && !M.hitDone && M.t > 0.2) free(0.3);
        break;
      }
      case 'whiff': if (M.t > 0.3) free(0.25); break;
      case 'dodge': {
        const u = clamp(M.t / 0.5, 0, 1), e = 1 - Math.pow(1 - u, 2.2);
        const x = M.P0.x + M.move.x * M.dist * e, z = M.P0.z + M.move.z * M.dist * e;
        if (onGround()) groundXZ(x, z);
        const done = M.t > (M.side ? 0.58 : 0.66);
        if (done) free(0.28);
        break;
      }
      case 'hit': case 'down': {
        const dur = M.name === 'hit' ? 0.3 : 0.5;
        const u = clamp(M.t / dur, 0, 1), e = 1 - (1 - u) * (1 - u);
        if (onGround()) groundXZ(M.P0.x + M.dir.x * M.dist * e, M.P0.z + M.dir.z * M.dist * e);
        if (M.name === 'hit' && M.t > 0.38) free(0.2);
        if (M.name === 'down') {
          if (!M.up && M.t > (M.dead ? 2.2 : 1.0)) { M.up = true; layer.play('getUp', { ts: 1.2, fade: 0.12 }); if (M.dead || me.hp <= 0) { me.hp = me.maxHp; c.onPlayerDefeated(); } }
          if (M.up && M.t > (M.dead ? 2.2 : 1.0) + 0.8) free(0.25);
        }
        break;
      }
      case 'throw': {
        if (M.t > 0.42 && !M.released) {
          M.released = true;
          layer.play('punch2', { ts: 1.1, fade: 0.08 });
          if (M.target) face(yawTo(feet(), M.target.pos), true);
        }
        if (M.released && !M.launched && M.t > 0.42 + 0.23 / 1.1) { M.launched = true; c.props.launch(M.prop, M.target); c.sfx('whoosh', 24); }
        if (M.t > 1.0) free(0.25);
        break;
      }
    }
  }

  // ------------------------------------------------------------------ input -> moves
  function inputDir(I) {
    const cam = P.cam; const f = cam.forwardFlat(new THREE.Vector3()), r = cam.rightFlat(new THREE.Vector3());
    return f.multiplyScalar(I.move.y).addScaledVector(r, I.move.x);
  }
  let lastI = null;
  function attackInput(hold = false) {
    const I = lastI;
    const dir = I ? inputDir(I) : null;
    me.airborne = !onGround() && s.mode !== 'ground';
    if (M.name === 'air' || M.name === 'airStrike') {
      const T = M.target; if (T && T.alive) { airStrike(T, hold ? 2 : ((M.seg ?? -1) + 1) % 3, hold); } return true;
    }
    if (s.mode === 'air' || (s.mode === 'ground' && s.kin)) {
      const T = c.pickTarget(dir, 14, feet());
      if (T && s.mode === 'air') { diveStrike(T); return true; }
      return false;
    }
    if (s.mode !== 'ground') return false;
    const T = c.pickTarget(dir, 8.5, feet());
    if (!T) { // whiff in place (still readable)
      const S = COMBO[me.comboStep % 4]; me.comboStep = (me.comboStep + 1) % 4; me.lastAttackT = c.time;
      start('whiff'); layer.play(S.clip, { ts: S.ts, fade: 0.07 }); c.sfx('whoosh', 8); return true;
    }
    if (hold && (T.type !== 'brute' || T.stun > 0) && hdist(feet(), T.pos) < 4.5) { launcher(T); me.comboStep = 0; return true; }
    if (c.time - me.lastAttackT > 0.95) me.comboStep = 0;
    strike(T, me.comboStep % 4);
    me.comboStep = (me.comboStep + 1) % 4;
    return true;
  }

  // ------------------------------------------------------------------ C5 control override
  const CI = { move: { x: 0, y: 0 }, look: { dx: 0, dy: 0 }, swing: false, jump: false, zip: false, sprint: false, drop: false,
    swingPressed: false, jumpPressed: false, zipPressed: false, dropPressed: false, sprintPressed: false,
    swingReleased: false, jumpReleased: false, zipReleased: false, dropReleased: false, sprintReleased: false, jumpHeld: 0, aimT: 99, combat: true };
  function neutral(I) { CI.look = I.look; CI.aimT = I.aimT; CI.usingPad = I.usingPad; return CI; }
  function yankStrike(T) { // E at close range: web yank into an ender
    c.fx.strand(() => rig.handWorld('R', new THREE.Vector3()), () => T.chest(new THREE.Vector3()), { life: 0.22, sag: 0.02, fade: 0.08 });
    c.sfx('thwip', 1.1); strike(T, 3);
  }
  const deny = msg => { c.hud.flash(msg); c.sfx('deny'); };
  // start the buffered action k if possible; returns true when the press was consumed
  function doAction(k, I) {
    const dir = inputDir(I), air = s.mode !== 'ground' || M.name === 'air' || M.name === 'airStrike';
    if (k === 'attack') return attackInput(false);
    if (k === 'web') { const T = (M.name === 'air' || M.name === 'airStrike') ? M.target : c.pickTarget(dir, 26, feet(), 0, true) || c.pickTarget(dir, 26, feet()); if (T) webShoot(T); else deny('No target'); return true; }
    if (air && k !== 'strike') { deny('Not in the air'); return true; }
    if (k === 'strike') {
      const far = c.pickTarget(dir, 22, feet(), 3.5, true);
      if (far) { if (s.mode === 'swing') P.web?.release?.(); webStrike(far); return true; }
      const near = !air && c.pickTarget(dir, 3.5, feet());
      if (near) { yankStrike(near); return true; }
      deny('No target'); return true;
    }
    if (k === 'finisher') {
      const T = c.pickTarget(dir, 10, feet()); if (!T) { deny('No target'); return true; }
      const cost = T.type === 'brute' ? 2 : 1;
      if (me.focus < cost) { deny(cost > 1 ? 'Brutes need 2 focus' : 'Need focus'); return true; }
      me.focus -= cost; finisher(T); return true;
    }
    if (k === 'heal') { if (me.focus >= 1 && me.hp < me.maxHp) { me.focus -= 1; c.heal(35); } else deny(me.focus < 1 ? 'Need focus' : 'Health full'); return true; }
    if (k === 'throw') {
      const pr = c.props.nearest(feet(), 14), T = c.pickTarget(dir, 25, feet());
      if (pr && T) { throwProp(pr, T); return true; }
      deny(pr ? 'No target' : 'Nothing to throw'); return true;
    }
    return true;
  }
  me.override = (I, dt) => {
    lastI = I;
    const inp = c.input;
    me.airborne = s.mode === 'air' || s.mode === 'swing' || s.mode === 'zip' || M.name === 'air' || M.name === 'airStrike' || M.name === 'launch' && M.rise;
    const tr = layer.top(), clipT = tr ? tr.t : 0;
    // --- held attack: cancel the jab that fired on press into the launcher (ground) / slam (air)
    if (inp.holdNow()) {
      if (M.name === 'strike' && !M.long && M.target?.alive && c.time - M.pressT < 0.35 && (M.target.type !== 'brute' || M.target.stun > 0)) { launcher(M.target); me.comboStep = 0; }
      else if ((M.name === 'air' || M.name === 'airStrike') && M.target?.alive) airStrike(M.target, 2, true);
      else if (M.name === 'free' || M.name === 'whiff') { attackInput(true); }
    }
    // --- dodge: dedicated key anytime; Space while the spider-sense is tingling or mid-attack
    const threat = c.nearestThreat();
    const wantDodge = inp.take('dodge') || (I.jumpPressed && (threat || (M.name === 'strike' || M.name === 'hit')) && s.mode === 'ground');
    if (wantDodge && s.mode === 'ground' && M.name !== 'down' && M.name !== 'finisher' && M.name !== 'throw') {
      const tdir = threat ? _v.set(threat.e.pos.x - s.pos.x, 0, threat.e.pos.z - s.pos.z).normalize().clone() : new THREE.Vector3();
      const perfect = !!threat && threat.at - c.time <= 0.3 && threat.at - c.time > -0.05;
      dodge(tdir, perfect, inputDir(I));
      c.onDodge(threat, perfect);
      return neutral(I);
    }
    // --- buffered actions: run when free or inside a cancel window
    const cancel = M.name === 'free' || M.name === 'whiff' && M.t > 0.1
      || M.name === 'strike' && M.hitDone && clipT >= M.hit + 0.05
      || M.name === 'dodge' && (M.perfect ? M.t > 0.08 : M.t > 0.38)
      || M.name === 'hit' && M.t > 0.3
      || (M.name === 'air' || M.name === 'airStrike' && M.hitDone);
    if (cancel) {
      for (const k of ['finisher', 'throw', 'strike', 'heal', 'attack', 'web']) {
        if (!inp.has(k)) continue;
        inp.take(k); doAction(k, I);
        break;
      }
    } else if (inp.has('web') && !['dodge', 'down', 'finisher', 'throw', 'hit', 'webStrike'].includes(M.name)) { inp.take('web'); doAction('web', I); }
    if (me.hp <= 0 && M.name !== 'down' && s.mode === 'ground') { const e = c.enemies.find(x => x.alive); if (e) { takeHit(e, 0, true); return neutral(I); } }
    if (M.name !== 'free') { motion(dt); return neutral(I); }
    // free: normal traversal input in combat stance. While engaged E never web-zips out of the fight.
    I.combat = true; I.dropPressed = false; I.drop = false; I.zipPressed = false; I.zip = false;
    return I;
  };
  me.late = (dt) => { layer.apply(dt); };
  me.reset = () => { free(0.3); me.comboStep = 0; };
  me.moveName = () => M.name;
  return me;
}
