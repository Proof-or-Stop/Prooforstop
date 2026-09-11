#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv) {
 const int version=argc>1 && strcmp(argv[1],"--version")==0;
 const char *log=getenv("U08_FIXTURE_PROBE_LOG");
 if(log) { FILE *f=fopen(log,"a"); if(f){fprintf(f,"%s\n",version?"version":"probe");fclose(f);}else puts("NATIVE_PROVIDER_STARTED_READONLY_LOG"); }
 if(version){puts("codex-cli fixture 1.0.0");return 0;}
 /* Consume the real launcher's prompt before exiting, preserving stdin delivery. */
 int byte;while((byte=getchar())!=EOF){}
 const char *home=getenv("CODEX_HOME");
 if(home){char path[8192];snprintf(path,sizeof(path),"%s/auth.json",home);FILE *f=fopen(path,"w");if(!f)return 72;fputs("{\"OPENAI_API_KEY\":\"fixture-refreshed-token\"}",f);fclose(f);}
 puts("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"READY\"}}");
 return 0;
}
