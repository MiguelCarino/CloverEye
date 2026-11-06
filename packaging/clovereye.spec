# SPDX-License-Identifier: AGPL-3.0-only
#
# Binary RPM for the CloverEye desktop shell. packaging/build-rpm.sh compiles
# the app with cargo first (the same release build as `cargo tauri build`) and
# hands its output to this spec as the source directory; rpmbuild only installs
# files. Run it on (or in a container of) the Fedora release the RPM is for.

Name:           clovereye
Version:        %{ce_version}
Release:        1%{?dist}
Summary:        Unofficial desktop client for 4chan
License:        AGPL-3.0-only AND OFL-1.1
URL:            https://github.com/MiguelCarino/CloverEye
ExclusiveArch:  x86_64

# The ELF dependency scan adds webkit2gtk4.1 and gtk3.
Requires:       hicolor-icon-theme
# Clip needs an ffmpeg with libvpx, SVT-AV1, Opus and libass (Fedora's
# ffmpeg-free or RPM Fusion's ffmpeg, either provides the file); the app checks it
# at run time and still reads boards without it.
Recommends:     /usr/bin/ffmpeg

%global debug_package %{nil}
%global __strip /bin/true

%description
CloverEye reads boards and threads in a three-pane layout, watches threads
and fits videos to a board's limits. It is not affiliated with or endorsed
by 4chan; the site's rules apply to everything read and posted through it.

%prep

%build

%install
install -Dm0755 %{_sourcedir}/clovereye %{buildroot}%{_bindir}/clovereye
install -Dm0644 %{_sourcedir}/clovereye.desktop %{buildroot}%{_datadir}/applications/clovereye.desktop
for s in 32 64 128 256 512; do
  install -Dm0644 %{_sourcedir}/icon-$s.png %{buildroot}%{_datadir}/icons/hicolor/${s}x${s}/apps/clovereye.png
done
install -Dm0644 %{_sourcedir}/LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
install -Dm0644 %{_sourcedir}/Inter-OFL.txt %{buildroot}%{_licensedir}/%{name}/Inter-OFL.txt
install -Dm0644 %{_sourcedir}/NotoSansMono-OFL.txt %{buildroot}%{_licensedir}/%{name}/NotoSansMono-OFL.txt
install -Dm0644 %{_sourcedir}/README.md %{buildroot}%{_docdir}/%{name}/README.md

%files
%license %{_licensedir}/%{name}/LICENSE
%license %{_licensedir}/%{name}/Inter-OFL.txt
%license %{_licensedir}/%{name}/NotoSansMono-OFL.txt
%doc %{_docdir}/%{name}/README.md
%{_bindir}/clovereye
%{_datadir}/applications/clovereye.desktop
%{_datadir}/icons/hicolor/*/apps/clovereye.png

%changelog
* Fri Nov 06 2026 MiguelCarino <miguel.carino1994@outlook.com> - 0.1.1-1
- Test build: captcha retries on the captcha page when the frame's abuse check fails.

* Wed Nov 04 2026 MiguelCarino <miguel.carino1994@outlook.com> - 0.1.0-1
- First test build: C0 setup wizard and shell, Fedora 44 and 45.
