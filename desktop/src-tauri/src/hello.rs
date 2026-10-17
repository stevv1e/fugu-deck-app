//! Windows Hello: подтверждение человеком (PIN, отпечаток, лицо) перед подписью ключом подтверждения.

#[cfg(windows)]
mod imp {
    use windows::core::HSTRING;
    use windows::Foundation::IAsyncOperation;
    use windows::Security::Credentials::UI::{UserConsentVerificationResult as R, UserConsentVerifier, UserConsentVerifierAvailability as A};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    pub fn available() -> bool {
        UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()).map(|a| a == A::Available).unwrap_or(false)
    }

    pub fn verify(hwnd: isize, message: &str) -> Result<(), String> {
        let interop = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.to_string())?;
        let op: IAsyncOperation<R> = unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as _), &HSTRING::from(message)) }
            .map_err(|e| format!("Windows Hello: {e}"))?;
        match op.get().map_err(|e| format!("Windows Hello: {e}"))? {
            R::Verified => Ok(()),
            R::Canceled => Err("Подтверждение отменено".into()),
            R::DeviceNotPresent | R::NotConfiguredForUser => Err("Windows Hello не настроен: задайте PIN в параметрах Windows → Учётные записи → Варианты входа".into()),
            R::DisabledByPolicy => Err("Windows Hello отключён политикой".into()),
            R::RetriesExhausted => Err("Слишком много попыток Windows Hello".into()),
            _ => Err("Windows Hello занят, попробуйте ещё раз".into()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn available() -> bool {
        false
    }
    pub fn verify(_: isize, _: &str) -> Result<(), String> {
        Err("Windows Hello есть только в Windows".into())
    }
}

pub use imp::*;
