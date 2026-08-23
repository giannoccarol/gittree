//! Token del design system GitTree (`src/renderer/styles/variables.css`)
//! per i temi dark e light, piu' metriche di layout condivise.

use gpui::Rgba;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeChoice {
    Dark,
    Light,
}

/// Gradiente del canvas (`--canvas-gradient`, due stop su tre per gpui).
pub fn canvas_gradient(choice: ThemeChoice) -> gpui::Background {
    let (from, to) = match choice {
        ThemeChoice::Dark => (c(0x0a0a0a), c(0x131316)),
        ThemeChoice::Light => (c(0xeef3ff), c(0xeef9f7)),
    };
    gpui::linear_gradient(
        135.,
        gpui::linear_color_stop(from, 0.),
        gpui::linear_color_stop(to, 1.),
    )
}

#[derive(Clone, Copy)]
pub struct Theme {
    pub canvas: Rgba,
    pub surface_shell: Rgba,
    pub surface_primary: Rgba,
    pub surface_secondary: Rgba,
    pub surface_hover: Rgba,
    pub surface_active: Rgba,
    pub surface_input: Rgba,
    pub surface_selected: Rgba,
    pub text_primary: Rgba,
    pub text_secondary: Rgba,
    pub text_tertiary: Rgba,
    pub text_link: Rgba,
    pub text_inverse: Rgba,
    pub primary: Rgba,
    pub primary_hover: Rgba,
    pub primary_soft: Rgba,
    pub success_text: Rgba,
    pub error_text: Rgba,
    pub warning_text: Rgba,
    pub border_subtle: Rgba,
    pub border_default: Rgba,
    pub border_strong: Rgba,
    pub lane_colors: [Rgba; 8],
    pub graph_line: Rgba,
    pub diff_add_text: Rgba,
    pub diff_add_bg: Rgba,
    pub diff_del_text: Rgba,
    pub diff_del_bg: Rgba,
    pub diff_hunk_bg: Rgba,
    pub diff_hunk_text: Rgba,
}

pub const SANS: &str = "Adwaita Sans";
pub const MONO: &str = "Adwaita Mono";

fn c(value: u32) -> Rgba {
    gpui::rgb(value)
}

impl Theme {
    pub fn new(choice: ThemeChoice) -> Self {
        match choice {
            ThemeChoice::Dark => Self {
                canvas: c(0x0f0f11),
                surface_shell: c(0x151517),
                surface_primary: c(0x18181a),
                surface_secondary: c(0x1b1b1e),
                surface_hover: c(0x222226),
                surface_active: c(0x28282c),
                surface_input: c(0x141416),
                surface_selected: c(0x1a2f38),
                text_primary: c(0xf1f2f5),
                text_secondary: c(0x9aa0a6),
                text_tertiary: c(0x6e7680),
                text_link: c(0x8ab4f8),
                text_inverse: c(0x111113),
                primary: c(0xe4e6eb),
                primary_hover: c(0xffffff),
                primary_soft: c(0x26272b),
                success_text: c(0x56cb6b),
                error_text: c(0xff867f),
                warning_text: c(0xebb34d),
                border_subtle: c(0x30363d),
                border_default: c(0x484f58),
                border_strong: c(0x6e7681),
                lane_colors: [
                    c(0x58a6ff),
                    c(0xf85149),
                    c(0x3fb950),
                    c(0xd29922),
                    c(0xa371f7),
                    c(0x34d4fe),
                    c(0xf778ba),
                    c(0xd29922),
                ],
                graph_line: c(0x3a3f47),
                diff_add_text: c(0x7ee787),
                diff_add_bg: c(0x0b2616),
                diff_del_text: c(0xff867f),
                diff_del_bg: c(0x3b1518),
                diff_hunk_bg: c(0x162435),
                diff_hunk_text: c(0x58a6ff),
            },
            ThemeChoice::Light => Self {
                canvas: c(0xf3f6fb),
                surface_shell: c(0xf7f9fc),
                surface_primary: c(0xffffff),
                surface_secondary: c(0xf2f5f9),
                surface_hover: c(0xedf2f8),
                surface_active: c(0xe3eaf5),
                surface_input: c(0xf6f8fb),
                surface_selected: c(0xe3edf7),
                text_primary: c(0x101828),
                text_secondary: c(0x475467),
                text_tertiary: c(0x7a8699),
                text_link: c(0x173b72),
                text_inverse: c(0xffffff),
                primary: c(0x102a4c),
                primary_hover: c(0x173b68),
                primary_soft: c(0xe6edf7),
                success_text: c(0x205f41),
                error_text: c(0x912018),
                warning_text: c(0x7a5200),
                border_subtle: c(0xe3e8ef),
                border_default: c(0xd5dce6),
                border_strong: c(0xb8c3d2),
                lane_colors: [
                    c(0x2f6fb2),
                    c(0xd1495b),
                    c(0x4f9d69),
                    c(0xc58623),
                    c(0x7557a8),
                    c(0x218b8b),
                    c(0xb85c9e),
                    c(0x6f7f32),
                ],
                graph_line: c(0xc7d2e1),
                diff_add_text: c(0x205f41),
                diff_add_bg: c(0xe8f5ed),
                diff_del_text: c(0x912018),
                diff_del_bg: c(0xfdecea),
                diff_hunk_bg: c(0xe7f1fb),
                diff_hunk_text: c(0x245d92),
            },
        }
    }
}
