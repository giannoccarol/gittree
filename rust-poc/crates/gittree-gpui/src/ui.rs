//! Helper di stile condivisi che replicano le classi di
//! `src/renderer/styles/components.css` (btn, chip, segmented, badge,
//! pannelli bento) con i token del tema corrente.

use gpui::{
    Animation, AnimationExt, AnyElement, Div, ElementId, FontWeight, InteractiveElement,
    ParentElement, SharedString, Stateful, Styled, div, px, svg,
};

use crate::motion;
use crate::theme::Theme;

/// Icona Phosphor regolare servita da `crate::icons::EmbeddedIcons`.
pub fn icon(name: &'static str, size: f32, color: gpui::Rgba) -> gpui::Svg {
    svg()
        .path(name)
        .size(px(size))
        .flex_shrink()
        .text_color(color)
}

/// Icona con il respiro `motion-pulse-soft` (2.4s, infinite): spinner
/// d'attesa e icone degli empty state come nell'app Electron.
pub fn pulsing_icon(name: &'static str, size: f32, color: gpui::Rgba) -> AnyElement {
    let glyph = icon(name, size, color);
    div()
        .flex()
        .items_center()
        .with_animation(
            SharedString::from(format!("pulse-{name}")),
            Animation::new(motion::PULSE_SOFT)
                .repeat()
                .with_easing(gpui::pulsating_between(0.55, 1.0)),
            move |container, alpha| container.opacity(alpha),
        )
        .child(glyph)
        .into_any_element()
}

/// Pannello bento arrotondato (`.bento-panel`: radius-lg 18px).
pub fn panel(theme: Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .rounded(px(18.0))
        .overflow_hidden()
        .bg(theme.surface_primary)
        .border_1()
        .border_color(theme.border_subtle)
}

/// Card annidata (radius-md 12px): tonalita' solida, nessuna elevazione.
pub fn card(theme: Theme) -> Div {
    div()
        .flex()
        .flex_col()
        .rounded(px(12.0))
        .overflow_hidden()
        .bg(theme.surface_primary)
        .border_1()
        .border_color(theme.border_subtle)
}

/// Bottone della command bar (`.btn-toolbar`, pill 32px su surface-secondary).
pub fn btn_toolbar(id: impl Into<ElementId>, theme: Theme, active: bool) -> Stateful<Div> {
    let base = div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .gap_1p5()
        .h(px(32.0))
        .px_3()
        .rounded_full()
        .text_size(px(12.0))
        .border_1()
        .cursor_pointer();
    if active {
        base.text_color(theme.text_primary)
            .bg(theme.primary_soft)
            .border_color(theme.border_default)
    } else {
        base.text_color(theme.text_secondary)
            .bg(theme.surface_secondary)
            .border_color(theme.border_subtle)
            .hover(move |style| style.bg(theme.surface_hover))
            .active(move |style| style.bg(theme.surface_active))
    }
}

/// Bottone primario (`.btn-primary`).
pub fn btn_primary(id: impl Into<ElementId>, theme: Theme) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .gap_1p5()
        .h(px(CONTROL_HEIGHT))
        .px_3()
        .rounded_full()
        .text_size(px(12.0))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(theme.text_inverse)
        .bg(theme.primary)
        .border_1()
        .border_color(theme.primary)
        .cursor_pointer()
        .hover(move |style| style.bg(theme.primary_hover))
        .active(move |style| style.opacity(0.85))
}

/// Bottone circolare solo-icona (`.btn-icon`, 34px con bordo).
pub fn btn_icon(
    id: impl Into<ElementId>,
    theme: Theme,
    icon_name: &'static str,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .size(px(34.0))
        .rounded_full()
        .bg(theme.surface_secondary)
        .border_1()
        .border_color(theme.border_subtle)
        .text_color(theme.text_secondary)
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_hover)
                .border_color(theme.border_default)
                .text_color(theme.text_primary)
        })
        .child(icon(icon_name, ICON_HEADER_SIZE, theme.text_secondary))
}

/// Variante compatta per le righe dense (`.changes-file-action`, 28px).
pub fn btn_icon_sm(
    id: impl Into<ElementId>,
    theme: Theme,
    icon_name: &'static str,
) -> Stateful<Div> {
    div()
        .id(id.into())
        .flex()
        .items_center()
        .justify_center()
        .size(px(28.0))
        .flex_shrink()
        .rounded_full()
        .bg(theme.surface_secondary)
        .border_1()
        .border_color(theme.border_subtle)
        .text_color(theme.text_secondary)
        .cursor_pointer()
        .hover(move |style| {
            style
                .bg(theme.surface_primary)
                .border_color(theme.border_strong)
                .text_color(theme.text_primary)
        })
        .child(icon(icon_name, ICON_ROW_SIZE, theme.text_secondary))
}

/// Chip (`.chip`).
pub fn chip(theme: Theme, label: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .items_center()
        .h(px(20.0))
        .px_2()
        .mr_1()
        .rounded_full()
        .text_size(px(10.5))
        .text_color(theme.text_link)
        .bg(theme.primary_soft)
        .border_1()
        .border_color(theme.border_subtle)
        .child(label.into())
}

/// Badge contatore (`.badge`).
pub fn badge(theme: Theme, text: impl Into<SharedString>) -> Div {
    div()
        .flex()
        .items_center()
        .min_h(px(18.0))
        .px_1p5()
        .rounded_md()
        .text_size(px(11.0))
        .text_color(theme.text_secondary)
        .bg(theme.surface_secondary)
        .border_1()
        .border_color(theme.border_subtle)
        .child(text.into())
}

/// Contenitore segmented control (`.segmented-control`).
pub fn segmented(theme: Theme) -> Div {
    div()
        .flex()
        .gap_0p5()
        .p_0p5()
        .rounded_full()
        .bg(theme.surface_secondary)
        .border_1()
        .border_color(theme.border_subtle)
}

/// Voce del segmented control (26px, attiva su surface-primary).
pub fn segmented_item(id: &'static str, active: bool, theme: Theme) -> Stateful<Div> {
    let base = div()
        .id(id)
        .flex()
        .items_center()
        .gap_1()
        .h(px(26.0))
        .px_3()
        .rounded_full()
        .text_size(px(12.0))
        .cursor_pointer();
    if active {
        base.text_color(theme.text_primary)
            .bg(theme.surface_primary)
    } else {
        base.text_color(theme.text_secondary)
            .hover(move |style| style.text_color(theme.text_primary))
            .active(move |style| style.bg(theme.surface_active))
    }
}

const CONTROL_HEIGHT: f32 = 34.0;
const ICON_HEADER_SIZE: f32 = 14.0;
const ICON_ROW_SIZE: f32 = 12.0;
