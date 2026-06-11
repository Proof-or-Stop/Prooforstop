## 触发事件
2026-05-15 的 B-c9f5 用户反馈中，tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json 是用户要求重新生成的 viewer 产品输出，但 Koala gate 把它和无关 dirty 文件一样处理。

## 关键洞察
仅排除 Koala 自身 metadata 还不够，因为用户交付可能包含受控生成物。系统需要让 story、checklist 或 verification evidence 声明哪些生成文件属于本次交付，而不是靠路径名猜测。

## 方案取舍
声明机制必须比全局 allowlist 更窄：只对当前 story 生效，必须能和 checklist/evidence/summary 对上，未声明的 tests/output 或 snapshot 变化仍然阻塞，避免把真实测试污染误放行。

## 对话纹理
用户要解决的是已经通过验证的产品输出被框架误判，期望看到的是 declared artifact 与 unexpected dirty files 分开报告，而不是让 agent 反复提交或回滚同一个生成文件。
