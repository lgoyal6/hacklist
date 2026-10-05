// Constraint Console: an App SDK app in the Sanity Dashboard for editors.
//   Rules       every constraint with its live blast radius; change one and see,
//               before committing, which poems it will break
//   Changes     the cascade log the recheck function writes
//   Workflow    every poem's review instance, live, grouped by stage, with the
//               actions the engine says this editor may take
import {type SanityConfig} from '@sanity/sdk'
import {SanityApp} from '@sanity/sdk-react'
import {Card, Container, Spinner, Tab, TabList, TabPanel, ThemeProvider, studioTheme} from '@sanity/ui'
import {Suspense, useState} from 'react'

import {ChangeLog} from './ChangeLog'
import {DATASET, PROJECT_ID} from './config'
import {RulesBoard} from './RulesBoard'
import {WorkflowBoard} from './WorkflowBoard'

const config: SanityConfig[] = [{projectId: PROJECT_ID, dataset: DATASET}]

export default function App() {
  const [tab, setTab] = useState<'rules' | 'changes' | 'workflow'>('rules')
  return (
    <ThemeProvider theme={studioTheme}>
      <SanityApp config={config} fallback={<Spinner />}>
        <Container width={4} padding={4}>
          <TabList gap={2}>
            <Tab aria-controls="rules" id="rules-tab" label="Rules" onClick={() => setTab('rules')} selected={tab === 'rules'} />
            <Tab aria-controls="changes" id="changes-tab" label="Changes" onClick={() => setTab('changes')} selected={tab === 'changes'} />
            <Tab aria-controls="workflow" id="workflow-tab" label="Workflow" onClick={() => setTab('workflow')} selected={tab === 'workflow'} />
          </TabList>
          <Card marginTop={4}>
            <Suspense fallback={<Spinner />}>
              <TabPanel aria-labelledby="rules-tab" id="rules" hidden={tab !== 'rules'}>{tab === 'rules' && <RulesBoard />}</TabPanel>
              <TabPanel aria-labelledby="changes-tab" id="changes" hidden={tab !== 'changes'}>{tab === 'changes' && <ChangeLog />}</TabPanel>
              <TabPanel aria-labelledby="workflow-tab" id="workflow" hidden={tab !== 'workflow'}>{tab === 'workflow' && <WorkflowBoard />}</TabPanel>
            </Suspense>
          </Card>
        </Container>
      </SanityApp>
    </ThemeProvider>
  )
}
