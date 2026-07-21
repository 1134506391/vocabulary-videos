<template>
  <div>
    <button @click="generateVideo">Generate Video</button>
    <button @click="getVideo">Get Video</button>
  </div>
</template>

<script>
import axios from 'axios'
export default {
  name: 'GeneratorVideo',
  data() {
    return {
      status: null
    }
  },
  methods: {
    generateVideo() {
        axios.post('/videos/start').then(response => {
            console.log(response.data)
        }).catch(error => {
            console.log(error)
        })  
    },
    getVideo() {
        axios.get('/videos/status').then(response => {
            this.status = response.data
            console.log(response.data)
        }).catch(error => {  
            console.log(error)
        })
    }
  }
}
</script>