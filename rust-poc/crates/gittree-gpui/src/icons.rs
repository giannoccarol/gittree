//! Icone Phosphor regular (MIT, © Phosphor Icons) embeddate come asset SVG
//! e servite ad `gpui::svg` tramite `AssetSource`. Le repliche dell'app
//! Electron usano `currentColor`: qui il colore arriva da `text_color`.

use std::borrow::Cow;

use gpui::{AssetSource, SharedString};

const ICON_PATHS: &[(&str, &[u8])] = &[
    ("icons/caret-left.svg", include_bytes!("../../assets/icons/caret-left.svg")),
    ("icons/caret-right.svg", include_bytes!("../../assets/icons/caret-right.svg")),
    ("icons/circle-notch.svg", include_bytes!("../../assets/icons/circle-notch.svg")),
    ("icons/cloud-arrow-down.svg", include_bytes!("../../assets/icons/cloud-arrow-down.svg")),
    ("icons/download-simple.svg", include_bytes!("../../assets/icons/download-simple.svg")),
    ("icons/git-branch.svg", include_bytes!("../../assets/icons/git-branch.svg")),
    ("icons/magnifying-glass.svg", include_bytes!("../../assets/icons/magnifying-glass.svg")),
    ("icons/minus.svg", include_bytes!("../../assets/icons/minus.svg")),
    ("icons/moon.svg", include_bytes!("../../assets/icons/moon.svg")),
    ("icons/plus.svg", include_bytes!("../../assets/icons/plus.svg")),
    ("icons/sidebar-simple.svg", include_bytes!("../../assets/icons/sidebar-simple.svg")),
    ("icons/sun.svg", include_bytes!("../../assets/icons/sun.svg")),
    ("icons/upload-simple.svg", include_bytes!("../../assets/icons/upload-simple.svg")),
    ("icons/x.svg", include_bytes!("../../assets/icons/x.svg")),
];

pub struct EmbeddedIcons;

impl AssetSource for EmbeddedIcons {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        Ok(
            ICON_PATHS
                .iter()
                .find(|(name, _)| *name == path)
                .map(|(_, bytes)| Cow::Borrowed(*bytes)),
        )
    }

    fn list(&self) -> Vec<SharedString> {
        ICON_PATHS
            .iter()
            .map(|(name, _)| SharedString::from(*name))
            .collect()
    }
}
