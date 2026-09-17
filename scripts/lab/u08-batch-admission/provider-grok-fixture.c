/* Synthetic provider only: no network, no product review authority. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
static const char *arg(int argc,char **argv,const char *key){for(int i=1;i+1<argc;i++)if(!strcmp(argv[i],key))return argv[i+1];return NULL;}
static void emit(const char *text){
 const char *tag="FIXTURE_RUN_ID",*run=getenv("LATTICE_MANAGED_HOST_RUN_ID"),*at=text;
 while(run){const char *hit=strstr(at,tag);if(!hit)break;fwrite(at,1,(size_t)(hit-at),stdout);fputs(run,stdout);at=hit+strlen(tag);}fputs(at,stdout);
}
int main(int argc,char **argv){
 if(argc>1&&!strcmp(argv[1],"--version")){puts("grok fixture 1.0.0");return 0;}
 /* Complete the real supervisor's input/attestation delivery before exiting. */
 int byte;while((byte=getchar())!=EOF){}
 const char *descriptor=getenv("LATTICE_MANAGED_REVIEW_INVOCATION_FD");
 if(descriptor){FILE *input=fdopen(atoi(descriptor),"r");if(!input)return 70;while(fgetc(input)!=EOF){}fclose(input);}
 const char *home=getenv("GROK_HOME"),*original=getenv("GROK_FIXTURE_ORIGINAL_HOME"),*updater=getenv("GROK_DISABLE_AUTOUPDATER");
 if(!home||!original||!strcmp(home,original)||!updater||strcmp(updater,"1"))return 71;
 char file[8192],config[8192]={0};snprintf(file,sizeof(file),"%s/config.toml",home);FILE *f=fopen(file,"r");if(!f)return 72;fread(config,1,sizeof(config)-1,f);fclose(f);
 if(!strstr(config,"use_leader = false")||!strstr(config,"auto_update = false"))return 73;
 struct stat mode;if(stat(home,&mode)||(mode.st_mode&077)!=0)return 74;
 snprintf(file,sizeof(file),"%s/auth.json",home);if(stat(file,&mode)||(mode.st_mode&077)!=0)return 75;
 const char *prompt=arg(argc,argv,"--prompt-file");if(!prompt||!(f=fopen(prompt,"r")))return 76;fclose(f);
 if(!arg(argc,argv,"--json-schema")){puts("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"READY\"}");return 0;}
 if(!arg(argc,argv,"--permission-mode")||strcmp(arg(argc,argv,"--permission-mode"),"bypassPermissions"))return 77;
 if(getenv("GROK_FIXTURE_ACCEPTANCE")&&!strstr(arg(argc,argv,"--json-schema"),"acceptance_amendment_review_final.v1"))return 78;
 const char *reads=getenv("GROK_FIXTURE_READ_FILES");if(reads){char *list=strdup(reads);for(char *name=strtok(list,"\n");name;name=strtok(NULL,"\n")){f=fopen(name,"r");if(!f){free(list);return 79;}while(fgetc(f)!=EOF){}fclose(f);}free(list);}
 fprintf(stderr,"GROK_FIXTURE_PRIVATE_HOME_VERIFIED:%s\n",home);
 const char *behavior=getenv("GROK_FIXTURE_MODE"),*proposal=getenv("GROK_FIXTURE_FINAL");
 if(behavior&&!strcmp(behavior,"missing"))return 0;
 if(!proposal)return 80;
 fputs("{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":",stdout);emit(proposal);puts("}");
 if(behavior&&!strcmp(behavior,"late-error"))puts("{\"type\":\"error\",\"message\":\"fixture late error\"}");
 return 0;
}
