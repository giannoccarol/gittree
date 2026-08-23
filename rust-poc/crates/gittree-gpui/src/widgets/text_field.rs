//! Campo testo riutilizzabile per il port GPUI (singola riga e multi-riga).
//! Adattato dall'esempio `input.rs` del crate gpui, con gestione IME completa.

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

use gpui::{
    App, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    EntityInputHandler, FocusHandle, Focusable, GlobalElementId, InteractiveElement, IntoElement,
    KeyBinding, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad,
    ParentElement, Pixels, Point, Render, ShapedLine, SharedString, Style, Styled, TextRun,
    UTF16Selection, Window, actions, div, px,
};

actions!(
    text_field,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Submit,
        Newline,
        Paste,
        Cut,
        Copy
    ]
);

pub type TextFieldSubmitCallback =
    Box<dyn Fn(&str, &mut Window, &mut Context<TextField>) + 'static>;
pub type TextFieldChangeCallback = Box<dyn Fn(&str, &mut Context<TextField>) + 'static>;

pub struct TextField {
    focus_handle: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    multiline: bool,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_lines: Option<Vec<(ShapedLine, Pixels)>>,
    last_bounds: Option<gpui::Bounds<Pixels>>,
    is_selecting: bool,
    on_submit: Option<TextFieldSubmitCallback>,
    on_change: Option<TextFieldChangeCallback>,
}

impl TextField {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: "".into(),
            placeholder: "".into(),
            multiline: false,
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_lines: None,
            last_bounds: None,
            is_selecting: false,
            on_submit: None,
            on_change: None,
        }
    }

    pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
        self.placeholder = placeholder.into();
        self
    }

    pub fn multiline(mut self, multiline: bool) -> Self {
        self.multiline = multiline;
        self
    }

    pub fn set_on_submit(
        &mut self,
        callback: impl Fn(&str, &mut Window, &mut Context<Self>) + 'static,
    ) {
        self.on_submit = Some(Box::new(callback));
    }

    /// Handle di focus da usare con `window.focus`.
    pub fn handle(&self) -> FocusHandle {
        self.focus_handle.clone()
    }

    pub fn value(&self) -> &str {
        &self.content
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    pub fn set_value(&mut self, value: &str, cx: &mut Context<Self>) {
        self.content = value.to_string().into();
        let end = self.content.len();
        self.selected_range = end..end;
        cx.notify();
        self.emit_change(cx);
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.set_value("", cx);
    }

    fn emit_change(&mut self, cx: &mut Context<Self>) {
        if let Some(callback) = self.on_change.take() {
            let content = self.content.clone();
            callback(&content, cx);
            self.on_change = Some(callback);
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        cx.notify();
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }

    fn line_start(&self, offset: usize) -> usize {
        self.content[..offset]
            .rfind('\n')
            .map(|idx| idx + 1)
            .unwrap_or(0)
    }

    fn line_end(&self, offset: usize) -> usize {
        self.content[offset..]
            .find('\n')
            .map(|idx| offset + idx)
            .unwrap_or(self.content.len())
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let Some(lines) = self.last_lines.as_ref() else {
            return 0;
        };
        if lines.is_empty() {
            return 0;
        }
        // Trova la riga il cui intervallo verticale contiene la posizione;
        // oltre l'ultima riga riporta alla fine del testo.
        let origin_x = self.last_bounds.map_or(px(0.), |bounds| bounds.left());
        let mut consumed = 0usize;
        for (idx, (line, y_offset)) in lines.iter().enumerate() {
            let next_y = lines
                .get(idx + 1)
                .map(|(_, next)| *next)
                .unwrap_or(Pixels::MAX);
            let inside = position.y >= *y_offset && position.y < next_y;
            if inside {
                let local_index = line.closest_index_for_x(position.x - origin_x);
                return consumed + local_index.min(line.text.len());
            }
            consumed += line.text.len() + 1;
        }
        self.content.len()
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        cx.notify();
    }

    fn edit_text(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content =
            (self.content[0..range.start].to_owned() + new_text + &self.content[range.end..])
                .into();
        self.selected_range = range.start + new_text.len()..range.start + new_text.len();
        self.marked_range.take();
        cx.notify();
        self.emit_change(cx);
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;
        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }
        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16_offset = 0;
        let mut utf8_count = 0;
        for ch in self.content.chars() {
            if utf8_count >= offset {
                break;
            }
            utf8_count += ch.len_utf8();
            utf16_offset += ch.len_utf16();
        }
        utf16_offset
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.offset_to_utf16(self.selected_range.start)
                ..self.offset_to_utf16(self.selected_range.end),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_text(range_utf16, new_text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content =
            (self.content[0..range.start].to_owned() + new_text + &self.content[range.end..])
                .into();
        if !new_text.is_empty() {
            self.marked_range = Some(range.start..range.start + new_text.len());
        } else {
            self.marked_range = None;
        }
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|range_utf16| self.range_from_utf16(range_utf16))
            .map(|new_range| new_range.start + range.start..new_range.end + range.end)
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: gpui::Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<gpui::Bounds<Pixels>> {
        let lines = self.last_lines.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let mut consumed = 0usize;
        let mut result: Option<gpui::Bounds<Pixels>> = None;
        for (line, y_offset) in lines {
            let seg_start = consumed;
            let seg_end = consumed + line.text.len();
            if range.start >= seg_start && range.start <= seg_end {
                let x0 = line.x_for_index(range.start - seg_start);
                let x1 = if range.end <= seg_end {
                    line.x_for_index(range.end - seg_start)
                } else {
                    line.width
                };
                result = Some(gpui::Bounds::from_corners(
                    Point::new(bounds.left() + x0, bounds.top() + *y_offset),
                    Point::new(
                        bounds.left() + x1,
                        bounds.top() + *y_offset + line.ascent + line.descent,
                    ),
                ));
                break;
            }
            consumed = seg_end + 1;
        }
        result
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let line_bounds = self.last_bounds?;
        let localized = line_bounds.localize(&point)?;
        let lines = self.last_lines.as_ref()?;
        let mut consumed = 0usize;
        for (idx, (line, y_offset)) in lines.iter().enumerate() {
            let next_y = lines
                .get(idx + 1)
                .map(|(_, next)| *next)
                .unwrap_or(Pixels::MAX);
            let inside = localized.y >= *y_offset && localized.y < next_y;
            if inside {
                return consumed
                    .checked_add(line.index_for_x(localized.x)?)
                    .map(|index| self.offset_to_utf16(index));
            }
            consumed += line.text.len() + 1;
        }
        None
    }
}

struct TextElement {
    input: gpui::Entity<TextField>,
}

struct PrepaintState {
    lines: Vec<(ShapedLine, Pixels)>,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        style.size.height = window.line_height().into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: gpui::Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let content = input.content.clone();
        let selected_range = input.selected_range.clone();
        let cursor = input.cursor_offset();
        let style = window.text_style();

        let (display_text, text_color) = if content.is_empty() {
            (input.placeholder.clone(), gpui::hsla(0., 0., 0.5, 0.55))
        } else {
            (content, style.color)
        };

        let base_run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = window.line_height();

        let segments: Vec<&str> = if display_text.is_empty() {
            vec![""]
        } else {
            display_text.split('\n').collect()
        };

        let mut lines = Vec::with_capacity(segments.len());
        let mut selections = Vec::new();
        let mut cursor_quad: Option<PaintQuad> = None;
        let mut consumed = 0usize;
        let mut y_offset = px(0.);
        for segment in segments {
            let run = TextRun {
                len: segment.len(),
                ..base_run.clone()
            };
            let shaped = window.text_system().shape_line(
                SharedString::from(segment.to_string()),
                font_size,
                &[run],
                None,
            );
            let seg_start = consumed;
            let seg_end = consumed + segment.len();

            let intersects_selection = !selected_range.is_empty()
                && selected_range.start < seg_end
                && selected_range.end > seg_start;
            if intersects_selection {
                let sel_start = selected_range.start.clamp(seg_start, seg_end) - seg_start;
                let sel_end = selected_range.end.clamp(seg_start, seg_end) - seg_start;
                let x0 = shaped.x_for_index(sel_start);
                let x1 = shaped.x_for_index(sel_end);
                selections.push(gpui::fill(
                    gpui::Bounds::from_corners(
                        Point::new(bounds.left() + x0, bounds.top() + y_offset),
                        Point::new(bounds.left() + x1, bounds.top() + y_offset + line_height),
                    ),
                    gpui::rgba(0x58a6ff40),
                ));
            }

            if selected_range.is_empty() && cursor >= seg_start && cursor <= seg_end {
                let cursor_pos = shaped.x_for_index(cursor - seg_start);
                cursor_quad = Some(gpui::fill(
                    gpui::Bounds::new(
                        Point::new(bounds.left() + cursor_pos, bounds.top() + y_offset),
                        gpui::size(px(2.), line_height),
                    ),
                    gpui::blue(),
                ));
            }

            lines.push((shaped, y_offset));
            y_offset += line_height;
            consumed = seg_end + 1;
        }

        PrepaintState {
            lines,
            cursor: cursor_quad,
            selections,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: gpui::Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        for selection in prepaint.selections.drain(..) {
            window.paint_quad(selection);
        }
        let line_height = window.line_height();
        let mut positioned = Vec::with_capacity(prepaint.lines.len());
        for (line, y_offset) in prepaint.lines.drain(..) {
            line.paint(
                Point::new(bounds.left(), bounds.top() + y_offset),
                line_height,
                window,
                cx,
            )
            .ok();
            positioned.push((line, y_offset));
        }
        if focus_handle.is_focused(window)
            && let Some(cursor) = prepaint.cursor.take()
        {
            window.paint_quad(cursor);
        }
        self.input.update(cx, |input, _cx| {
            input.last_lines = Some(positioned);
            input.last_bounds = Some(bounds);
        });
    }
}

impl Render for TextField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("text-field-root")
            .flex()
            .key_context("TextField")
            .track_focus(&self.focus_handle(cx))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::on_up))
            .on_action(cx.listener(Self::on_down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .size_full()
            .child(TextElement { input: cx.entity() })
    }
}

impl Focusable for TextField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl TextField {
    fn backspace(&mut self, _: &Backspace, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let boundary = self.previous_boundary(self.cursor_offset());
            self.selected_range = boundary..boundary;
        }
        self.edit_text(None, "", cx);
    }

    fn delete(&mut self, _: &Delete, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let boundary = self.next_boundary(self.cursor_offset());
            self.selected_range = boundary..boundary;
        }
        self.edit_text(None, "", cx);
    }

    fn left(&mut self, _: &Left, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), cx);
        } else {
            self.move_to(self.selected_range.end, cx);
        }
    }

    fn on_up(&mut self, _: &Up, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.multiline {
            return;
        }
        let cursor = self.cursor_offset();
        let start = self.line_start(cursor);
        let column = cursor - start;
        if start == 0 {
            return;
        }
        let prev_end = start - 1;
        let prev_start = self.line_start(prev_end);
        self.move_to((prev_start + column).min(prev_end), cx);
    }

    fn on_down(&mut self, _: &Down, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.multiline {
            return;
        }
        let cursor = self.cursor_offset();
        let end = self.line_end(cursor);
        let column = cursor - self.line_start(cursor);
        if end == self.content.len() {
            return;
        }
        let next_start = end + 1;
        let next_end = self.line_end(next_start);
        self.move_to((next_start + column).min(next_end), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx);
    }

    fn home(&mut self, _: &Home, _window: &mut Window, cx: &mut Context<Self>) {
        let target = if self.multiline {
            self.line_start(self.cursor_offset())
        } else {
            0
        };
        self.move_to(target, cx);
    }

    fn end(&mut self, _: &End, _window: &mut Window, cx: &mut Context<Self>) {
        let target = if self.multiline {
            self.line_end(self.cursor_offset())
        } else {
            self.content.len()
        };
        self.move_to(target, cx);
    }

    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            self.edit_text(None, "\n", cx);
            return;
        }
        if let Some(callback) = self.on_submit.take() {
            let content = self.content.clone();
            callback(&content, window, cx);
            self.on_submit = Some(callback);
        }
    }

    fn paste(&mut self, _: &Paste, _window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let text = if self.multiline {
                text
            } else {
                text.replace('\n', " ")
            };
            self.edit_text(None, &text, cx);
        }
    }

    fn cut(&mut self, _: &Cut, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.edit_text(None, "", cx);
        }
    }

    fn copy(&mut self, _: &Copy, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        } else {
            self.move_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _cx: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }
}

/// Associa i tasti del campo testo al contesto "TextField".
pub fn bind_keys(app: &mut App) {
    app.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextField")),
        KeyBinding::new("delete", Delete, Some("TextField")),
        KeyBinding::new("left", Left, Some("TextField")),
        KeyBinding::new("right", Right, Some("TextField")),
        KeyBinding::new("up", Up, Some("TextField")),
        KeyBinding::new("down", Down, Some("TextField")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextField")),
        KeyBinding::new("shift-right", SelectRight, Some("TextField")),
        KeyBinding::new("cmd-a", SelectAll, Some("TextField")),
        KeyBinding::new("ctrl-a", SelectAll, Some("TextField")),
        KeyBinding::new("home", Home, Some("TextField")),
        KeyBinding::new("end", End, Some("TextField")),
        KeyBinding::new("enter", Submit, Some("TextField")),
        KeyBinding::new("shift-enter", Submit, Some("TextField")),
        KeyBinding::new("ctrl-enter", Submit, Some("TextField")),
        KeyBinding::new("ctrl-v", Paste, Some("TextField")),
        KeyBinding::new("cmd-v", Paste, Some("TextField")),
        KeyBinding::new("ctrl-x", Cut, Some("TextField")),
        KeyBinding::new("cmd-x", Cut, Some("TextField")),
        KeyBinding::new("ctrl-c", Copy, Some("TextField")),
        KeyBinding::new("cmd-c", Copy, Some("TextField")),
    ]);
}
