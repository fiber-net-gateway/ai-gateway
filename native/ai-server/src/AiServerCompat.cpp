// Provides a local copy_file_range so the static libc++ link is self-contained
// on hosts whose glibc predates 2.27 (where copy_file_range was introduced).
//
// The ai-server only calls std::filesystem path helpers, but libc++'s
// filesystem implementation (operations.cpp) is pulled in as one object and
// references copy_file_range from its copy_file() path. Defining the symbol
// here satisfies that reference locally instead of requiring GLIBC >= 2.27 on
// the production machine. The fallback copies with pread64/pwrite64, which
// matches copy_file_range semantics for libc++'s 8 KiB-loop use.

#define _LARGEFILE64_SOURCE

#include <cerrno>
#include <cstddef>

#include <unistd.h>

extern "C" ssize_t copy_file_range(int fd_in, off64_t *off_in, int fd_out, off64_t *off_out, std::size_t len,
                                   unsigned int flags) {
    if (flags != 0) {
        errno = EINVAL;
        return -1;
    }
    char buffer[8192];
    const std::size_t chunk = len < sizeof(buffer) ? len : sizeof(buffer);
    ssize_t n = off_in != nullptr ? ::pread64(fd_in, buffer, chunk, *off_in) : ::read(fd_in, buffer, chunk);
    if (n < 0) {
        return -1;
    }
    if (n == 0) {
        return 0;
    }
    ssize_t written = off_out != nullptr ? ::pwrite64(fd_out, buffer, static_cast<std::size_t>(n), *off_out)
                                         : ::write(fd_out, buffer, static_cast<std::size_t>(n));
    if (written < 0) {
        return -1;
    }
    if (off_in != nullptr) {
        *off_in += written;
    }
    if (off_out != nullptr) {
        *off_out += written;
    }
    return written;
}
