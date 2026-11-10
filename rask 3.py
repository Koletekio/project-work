with open("我的一天.txt", "w", encoding="utf-8") as f:
    f.write("今天是11月4日，天气晴。\n")
    f.write("我今天上了就业指导课。\n")
    f.write("接下来我要做AI项目了。\n")

print("已经写入")
with open("我的一天.txt", "r", encoding="utf-8") as f:
    content = f.read()

print("正在读取内容")
print(content)