//! 小字符串工具。
//!
//! 核心:按**字节**上限安全截断 —— 落点回退到最近的 UTF-8 char 边界,
//! 绝不在多字节字符(中文 / emoji)中间切而 panic。YiYi 面向中文用户,
//! 错误/降级路径上的预览截断尤其容易踩到这个坑(见防屎山修复 E)。

/// 截断到至多 `max_bytes` 字节,落点 snap 到最近的 char 边界。
/// `s.len() <= max_bytes` 时原样返回。
pub fn truncate_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::truncate_bytes;

    #[test]
    fn truncate_bytes_snaps_to_char_boundary_no_panic() {
        // "中文" 每字 3 字节。max=4 落在第二个字中间 → 回退到 3(只留第一个字)。
        assert_eq!(truncate_bytes("中文测试", 4), "中");
        // 边界正好 → 不回退。
        assert_eq!(truncate_bytes("中文", 3), "中");
        // 够长不截。
        assert_eq!(truncate_bytes("hi", 100), "hi");
        // emoji 4 字节,max=2 落中间 → 回退到空。
        assert_eq!(truncate_bytes("😀x", 2), "");
        // 纯 ASCII 正常。
        assert_eq!(truncate_bytes("hello", 3), "hel");
    }
}
