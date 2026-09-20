# Android 混淆规则
#
# 本工程**刻意关闭了混淆**（app/build.gradle 里 minifyEnabled false）：
# 壳里只有几个类，混淆收益为零；而一旦 WebView 的 JS 桥或 Activity 被改名，
# 排查起来非常痛苦。
#
# 这个文件保留着，是为了以后真要开混淆时有地方写规则 —— 现在它是空的。
