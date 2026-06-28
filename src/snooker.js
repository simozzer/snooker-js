// snooker.js — physical constants for the snooker variant. SI units (metres, kg, seconds).
//
// The defining physical difference from carrom: a snooker ball ROLLS. A struck/collided
// ball first SLIDES (high kinetic friction, MU_SLIDE) while its contact patch slips, then
// — once the slip dies — ROLLS (low rolling resistance, MU_ROLL) to rest. Carrom conflates
// the two into a single deceleration; here they are separate regimes (see body.js
// twoPhasePlan). That two-phase split, plus the cue-tip spin it carries, is what produces
// follow / draw (screw) / swerve.

export const GRAVITY = 9.81;

// Tournament ball: ⌀52.5 mm, ~142 g. (Inertia of a uniform SPHERE is 2/5 m r², which sets
// the 7/2 slip-deceleration factor used in twoPhasePlan — not the disc's 1/2.)
export const BALL = { radius: 0.02625, mass: 0.142 };

// Cloth friction. Sliding is kinetic friction at the slipping contact (high); rolling is
// rolling resistance once the ball rolls without slipping (low). Tunable against real shots.
export const MU_SLIDE = 0.2;
export const MU_ROLL = 0.02; // napped snooker cloth is slower than slick pool felt

// Restitution / tangential friction at impulsive contacts.
export const BALL_RESTITUTION = 0.95; // ball–ball normal restitution (near-elastic)
export const BALL_FRICTION_T = 0.06; // ball–ball tangential ("cut-induced throw")
export const CUSHION_RESTITUTION = 0.8; // perpendicular bounce off a rail
export const CUSHION_FRICTION_T = 0.2; // cushion tangential (side-spin grip)

// Vertical-axis ("side"/English) spin decay on the cloth, as an angular deceleration
// dω_z/dt = SIDE_DECEL (rad/s²). Side spin doesn't translate the ball (its slip at the
// bottom contact is zero) — it only matters at cushion/ball contacts — but it bleeds off.
export const SIDE_DECEL = 10.0;

// Sphere inertia factor: I = INERTIA_FACTOR · m r².
export const INERTIA_FACTOR = 2 / 5;
// Slip decays (7/2)× faster than the centre under sliding friction: 1 + 1/INERTIA_FACTOR.
export const SLIP_FACTOR = 1 + 1 / INERTIA_FACTOR; // = 7/2 for a uniform sphere

// Cue-tip → spin gain. A tip offset of `vert` (vertical, −1..1) or `side` (horizontal, −1..1)
// imparts angular velocity SPIN_GAIN·offset·v/R. With SPIN_GAIN=2: offset ≈0.5 ⇒ natural roll
// (no slide), offset 0 ⇒ stun, offset 1 ⇒ strong follow, −1 ⇒ strong screw. Tunable.
export const SPIN_GAIN = 2.0;
export const MAX_SPEED = 8.0; // m/s at full cue power
