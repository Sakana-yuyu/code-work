require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CodeworkReviewDiffNative'
  s.version = package['version']
  s.summary = 'Native review diff debug surface for CodexWork mobile.'
  s.description = 'Native iOS review diff renderer used to prototype fast mobile review scrolling.'
  s.homepage = 'https://github.com/Sakana-yuyu/code-work'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'Codework' => 'https://github.com/Sakana-yuyu/code-work' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'CoreGraphics', 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
