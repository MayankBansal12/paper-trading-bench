#include <seccomp.h>
#include <errno.h>
#include <unistd.h>
#include <linux/sched.h>
int main(void) {
 scmp_filter_ctx ctx=seccomp_init(SCMP_ACT_ALLOW); if(!ctx)return 1;
 const char *deny[]={"mount","umount2","pivot_root","ptrace","process_vm_readv","process_vm_writev","bpf","perf_event_open","keyctl","add_key","request_key","reboot","kexec_load","kexec_file_load","init_module","finit_module","delete_module","open_by_handle_at","name_to_handle_at","setns","unshare","userfaultfd","io_uring_setup","io_uring_enter","io_uring_register","swapon","swapoff","acct","quotactl","settimeofday","clock_settime",NULL};
 for(int i=0;deny[i];i++){int n=seccomp_syscall_resolve_name(deny[i]);if(n!=__NR_SCMP_ERROR && seccomp_rule_add(ctx,SCMP_ACT_ERRNO(EPERM),n,0))return 2;}
 if(seccomp_rule_add(ctx,SCMP_ACT_ERRNO(ENOSYS),SCMP_SYS(clone3),0))return 3;
 unsigned long flags[]={CLONE_NEWUSER,CLONE_NEWNS,CLONE_NEWNET,CLONE_NEWPID,CLONE_NEWUTS,CLONE_NEWIPC,CLONE_NEWCGROUP};
 for(unsigned i=0;i<sizeof(flags)/sizeof(flags[0]);i++)if(seccomp_rule_add(ctx,SCMP_ACT_ERRNO(EPERM),SCMP_SYS(clone),1,SCMP_A0(SCMP_CMP_MASKED_EQ,flags[i],flags[i])))return 4;
 int result=seccomp_export_bpf(ctx,STDOUT_FILENO);seccomp_release(ctx);return result<0?5:0;
}
