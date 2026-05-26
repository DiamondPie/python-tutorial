# Markdown Extension Examples

This page demonstrates some of the built-in markdown extensions provided by VitePress.

<PythonRunner initialCode="print('欢迎来到我的 Python 教程！')
for i in range(3):
    print(f'循环计数：{i}')" />

<PythonRunner initialCode=
"import time
def fib(n):
    if n <= 1: return n
    return fib(n-1) + fib(n-2)
print('开始计算（这会花费几秒，但你可以正常滚动页面，不会卡顿）...')
start = time.time()
res = fib(32) 
print(f'结果: {res}, 耗时: {time.time() - start:.2f} 秒')`" />

## Syntax Highlighting

VitePress provides Syntax Highlighting powered by [Shiki](https://github.com/shikijs/shiki), with additional features like line-highlighting:

**Input**

````md
```js{4}
export default {
  data () {
    return {
      msg: 'Highlighted!'
    }
  }
}
```
````

**Output**

```js{4}
export default {
  data () {
    return {
      msg: 'Highlighted!'
    }
  }
}
```

## Custom Containers

**Input**

```md
::: info
This is an info box.
:::

::: tip
This is a tip.
:::

::: warning
This is a warning.
:::

::: danger
This is a dangerous warning.
:::

::: details
This is a details block.
:::
```

**Output**

::: info
This is an info box.
:::

::: tip
This is a tip.
:::

::: warning
This is a warning.
:::

::: danger
This is a dangerous warning.
:::

::: details
This is a details block.
:::

## More

Check out the documentation for the [full list of markdown extensions](https://vitepress.dev/guide/markdown).
