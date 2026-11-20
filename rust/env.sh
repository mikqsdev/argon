# Source before building with the GNU toolchain on Windows (Git Bash):  . rust/env.sh
# The windows-gnu target needs MinGW binutils (as + dlltool), e.g. from
#   winget install BrechtSanders.WinLibs.POSIX.UCRT
for d in "$LOCALAPPDATA"/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw64/bin /c/msys64/ucrt64/bin /c/msys64/mingw64/bin; do
	if [ -x "$d/dlltool.exe" ]; then
		export PATH="$(cygpath -u "$d" 2>/dev/null || echo "$d"):$PATH"
		break
	fi
done
