#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc,char **argv){
 const char *log=getenv("U08_FIXTURE_PROBE_LOG"),*mode=getenv("U08_FIXTURE_MODE");
 int version=argc>1&&strcmp(argv[1],"--version")==0;
 if(log){FILE*f=fopen(log,"a");if(!f)return 71;fprintf(f,"%s\n",version?"version":"probe");fclose(f);}
 if(version){puts("codex-cli fixture 1.0.0");return 0;}
 if(mode&&strcmp(mode,"auth")==0){fputs("authentication failed: invalid API key\n",stderr);return 1;}
 const char *home=getenv("CODEX_HOME");if(home){char path[8192];snprintf(path,sizeof(path),"%s/auth.json",home);FILE*f=fopen(path,"w");if(!f)return 72;fputs("{\"OPENAI_API_KEY\":\"fixture-refreshed-token\"}",f);fclose(f);}
 puts("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"READY\"}}");return 0;
}
