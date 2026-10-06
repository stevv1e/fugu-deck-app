Pod::Spec.new do |s|
  s.name           = 'FdSecure'
  s.version        = '1.0.0'
  s.summary        = 'Fugu Deck: device keys in Secure Enclave, App Attest, mTLS transport'
  s.description    = 'Device-bound keys (session + biometric confirm), signatures, client-certificate URLSession transport.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'LocalAuthentication', 'DeviceCheck', 'CryptoKit'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
