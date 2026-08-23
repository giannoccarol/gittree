//! Sistema di motion che replica `MOTION.md`, `DESIGN.md` e i keyframe
//! `motion-*` di `src/renderer/styles/variables.css`.
//!
//! GPUI 0.2 non ha transform CSS ne' transizioni su hover: slide e settle
//! sono replicati con offset `left`/`top` su elementi posizionati in modo
//! relativo e con `opacity`, cosi' il layout dei pannelli vicini resta
//! stabile durante il moto, come accade all'app Electron con `translate3d`.
//! Il feedback istantaneo dei controlli sostituisce le transizioni
//! `--transition-fast` (140ms); gli stati premuti usano i token surface-*.
//! Le curve che servono davvero ai pannelli e ai contenuti sono qui sotto.

use std::time::Duration;

/// `--transition-normal`: cambi di stato dei pannelli.
pub const PANEL_CHANGE: Duration = Duration::from_millis(220);
/// `--duration-normal`: entrate di contenuti, toast ed empty state.
pub const CONTENT_ENTER: Duration = Duration::from_millis(280);
/// Durata del `motion-badge-pop` (280ms con spring-gentle nel CSS).
pub const BADGE_POP: Duration = Duration::from_millis(280);
/// Periodo del `motion-pulse-soft` (2.4s ease-smooth infinite nel CSS).
pub const PULSE_SOFT: Duration = Duration::from_millis(2400);

/// `--ease-decel`: cubic-bezier(0.0, 0.0, 0.2, 1).
pub fn ease_decel() -> impl Fn(f32) -> f32 {
    cubic_bezier(0.0, 0.0, 0.2, 1.0)
}

/// `--ease-accel`: cubic-bezier(0.4, 0.0, 1, 1).
pub fn ease_accel() -> impl Fn(f32) -> f32 {
    cubic_bezier(0.4, 0.0, 1.0, 1.0)
}

/// `--ease-smooth`: cubic-bezier(0.25, 0.1, 0.25, 1).
pub fn ease_smooth() -> impl Fn(f32) -> f32 {
    cubic_bezier(0.25, 0.1, 0.25, 1.0)
}

/// `--spring-gentle`: cubic-bezier(0.22, 1.2, 0.36, 1), supera brevemente 1.
pub fn spring_gentle() -> impl Fn(f32) -> f32 {
    cubic_bezier(0.22, 1.2, 0.36, 1.0)
}

/// Respiro `motion-pulse-soft`: il progresso passa prima da `--ease-smooth`
/// e poi oscilla tra `min` e `max`, come l'opacita' degli spinner Electron.
pub fn breathing(min: f32, max: f32) -> impl Fn(f32) -> f32 {
    let smooth = ease_smooth();
    let pulse = gpui::pulsating_between(min, max);
    move |delta| pulse(smooth(delta))
}

/// Solver cubic-bezier CSS (curve parametriche con ascisse in [0, 1]).
///
/// Risolve `x(t) = input` con Newton-Raphson raffinato da bisezione e
/// restituisce `y(t)`; stesso approccio di WebKit per `cubic-bezier(...)`.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 {
    move |input| {
        if input <= 0.0 {
            return 0.0;
        }
        if input >= 1.0 {
            return 1.0;
        }
        let curve = BezierCurve { x1, y1, x2, y2 };
        bezier_y(curve, input)
    }
}

#[derive(Clone, Copy)]
struct BezierCurve {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

fn sample_x(curve: BezierCurve, t: f32) -> f32 {
    let baseline = 3.0 * t * (1.0 - t).powi(2);
    let midpoint = 3.0 * t.powi(2) * (1.0 - t);
    let endpoint = t.powi(3);
    baseline * curve.x1 + midpoint * curve.x2 + endpoint
}

fn sample_y(curve: BezierCurve, t: f32) -> f32 {
    let baseline = 3.0 * t * (1.0 - t).powi(2);
    let midpoint = 3.0 * t.powi(2) * (1.0 - t);
    let endpoint = t.powi(3);
    baseline * curve.y1 + midpoint * curve.y2 + endpoint
}

fn sample_derivative_x(curve: BezierCurve, t: f32) -> f32 {
    let baseline = 3.0 * (1.0 - t).powi(2) - 6.0 * t * (1.0 - t) + 3.0 * t.powi(2);
    let midpoint = 6.0 * t * (1.0 - t) - 3.0 * t.powi(2);
    let endpoint = 3.0 * t.powi(2);
    baseline * curve.x1 + midpoint * curve.x2 + endpoint
}

fn solve_curve_x(curve: BezierCurve, input: f32) -> f32 {
    let mut t = input;
    for _ in 0..8 {
        let error = sample_x(curve, t) - input;
        if error.abs() < 1e-6 {
            return t;
        }
        let derivative = sample_derivative_x(curve, t);
        if derivative.abs() < 1e-6 {
            break;
        }
        t -= error / derivative;
        t = t.clamp(0.0, 1.0);
    }
    let mut low = 0.0_f32;
    let mut high = 1.0_f32;
    t = input.clamp(0.0, 1.0);
    for _ in 0..20 {
        let error = sample_x(curve, t) - input;
        if error.abs() < 1e-6 {
            break;
        }
        if error > 0.0 {
            high = t;
        } else {
            low = t;
        }
        t = (low + high) / 2.0;
    }
    t
}

fn bezier_y(curve: BezierCurve, input: f32) -> f32 {
    sample_y(curve, solve_curve_x(curve, input))
}

/// Valore intermedio tra due estremi.
pub fn lerp(from: f32, to: f32, delta: f32) -> f32 {
    from + (to - from) * delta
}

// -- Keyframe `motion-panel-*` ----------------------------------------------

/// Tratto orizzontale del pannello in ingresso da sinistra:
/// `-52px → +2px (72%) → 0px` come `motion-panel-enter-left`.
pub fn panel_slide_enter(delta: f32) -> f32 {
    let eased = ease_decel()(delta);
    if eased < 0.72 {
        lerp(-52.0, 2.0, eased / 0.72)
    } else {
        lerp(2.0, 0.0, (eased - 0.72) / 0.28)
    }
}

/// Uscita verso sinistra: `0 → -44px` come `motion-panel-exit-left`.
pub fn panel_slide_exit_left(delta: f32) -> f32 {
    -44.0 * ease_accel()(delta)
}

/// Uscita verso destra: `0 → +44px` come `motion-panel-exit-right`.
pub fn panel_slide_exit_right(delta: f32) -> f32 {
    44.0 * ease_accel()(delta)
}

// -- Keyframe di contenuto ---------------------------------------------------

/// `motion-fade-in-up`: `translateY(12px) scale(0.98) → 0/1` con spring.
/// Restituisce `(offset_top_px, opacity)`; lo spring puo' superare 1.
pub fn fade_in_up(delta: f32) -> (f32, f32) {
    (12.0 * (1.0 - spring_gentle()(delta)), delta)
}

/// `motion-content-in`: `translateY(6px) → 0` con decelerazione.
/// Restituisce `(offset_top_px, opacity)`.
pub fn content_in(delta: f32) -> (f32, f32) {
    (6.0 * (1.0 - ease_decel()(delta)), ease_decel()(delta))
}

/// `motion-item-reveal`: comparsa soft di badge e voci.
/// Restituisce `(offset_top_px, opacity)`.
pub fn item_reveal(delta: f32) -> (f32, f32) {
    (
        (4.0 * (1.0 - ease_decel()(delta))).min(4.0),
        ease_decel()(delta),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn bezier_endpoints_are_exact() {
        for easing in [
            cubic_bezier(0.0, 0.0, 0.2, 1.0),
            cubic_bezier(0.4, 0.0, 1.0, 1.0),
            cubic_bezier(0.25, 0.1, 0.25, 1.0),
            cubic_bezier(0.22, 1.2, 0.36, 1.0),
        ] {
            assert!(close(easing(0.0), 0.0));
            assert!(close(easing(1.0), 1.0));
        }
    }

    #[test]
    fn decel_eases_fast_then_slow() {
        let ease = ease_decel();
        // Valori di riferimento di cubic-bezier(0, 0, 0.2, 1).
        assert!(
            ease(0.25) > 0.5,
            "decel anticipa nettamente il valore lineare: {}",
            ease(0.25)
        );
        let late = ease(0.75);
        assert!(
            (0.95..=0.98).contains(&late),
            "la coda decelera verso 1: {late}"
        );
    }

    #[test]
    fn spring_gentle_overshoots_then_settles() {
        let spring = spring_gentle();
        let max = (0..=100)
            .map(|step| spring(step as f32 / 100.0))
            .fold(0.0_f32, |peak, value| peak.max(value));
        assert!(max > 1.01, "lo spring deve superare 1, massimo {max}");
        assert!(max < 1.15, "l'overshoot resta gentile, massimo {max}");
    }

    #[test]
    fn panel_enter_left_matches_keyframes() {
        assert!(close(panel_slide_enter(0.0), -52.0));
        assert!(close(panel_slide_enter(1.0), 0.0));
        let overshoot_peak = panel_slide_enter(0.72);
        assert!(overshoot_peak > 0.0 && overshoot_peak <= 2.0 + 1e-3);
        // Il valore scende sotto zero solo all'inizio.
        assert!(panel_slide_enter(0.9) > 0.0 && panel_slide_enter(0.9) < overshoot_peak);
    }

    #[test]
    fn panel_exits_move_outward_and_fade() {
        assert!(close(panel_slide_exit_left(0.0), 0.0));
        assert!(close(panel_slide_exit_left(1.0), -44.0));
        assert!(close(panel_slide_exit_right(1.0), 44.0));
    }

    #[test]
    fn content_animations_start_offscreen_and_land_at_rest() {
        for keyframe in [fade_in_up, content_in, item_reveal] {
            let (start_offset, start_opacity) = keyframe(0.0);
            assert!(start_offset > 0.0);
            assert!(close(start_opacity, 0.0));
            let (end_offset, end_opacity) = keyframe(1.0);
            assert!(close(end_offset, 0.0));
            assert!(close(end_opacity, 1.0));
        }
    }

    #[test]
    fn durations_match_motion_contract() {
        assert_eq!(PANEL_CHANGE, Duration::from_millis(220));
        assert_eq!(CONTENT_ENTER, Duration::from_millis(280));
    }
}
