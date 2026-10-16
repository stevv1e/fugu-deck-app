// Без окна консоли в сборке для Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fugu_deck_lib::run()
}
