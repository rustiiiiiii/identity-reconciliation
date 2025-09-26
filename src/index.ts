import express from 'express';
import identifyRoutes from './routes/identifyRoutes.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Mount the identify routes
app.use('/', identifyRoutes);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});